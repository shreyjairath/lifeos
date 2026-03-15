package com.lifeos.core.agents.executor;

import com.lifeos.config.AppConfig;
import com.lifeos.core.helpers.EventBus;
import com.lifeos.core.managers.SessionManager;
import com.lifeos.core.agents.tools.ToolsRegistry;
import com.lifeos.core.agents.executor.events.AgentAppendEvent;
import com.lifeos.core.agents.executor.events.ExecutorEvent;
import com.lifeos.core.agents.executor.events.LlmEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import reactor.core.publisher.Flux;

import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Common base for user-facing agents.
 *
 * Subclasses implement:
 *   persona()    — the agent's identity/instructions string
 *   memory()  — knowledge section appended after persona (empty = omit)
 *   tools()      — tools list for chat mode (defaults to all from registry)
 */
public abstract class BaseAgent {

    private static final Logger log = LoggerFactory.getLogger(BaseAgent.class);
    private static final String REFLECT_MODEL = "claude-haiku-4-5-20251001";

    protected final Executor executor;
    protected final ToolsRegistry toolsRegistry;
    protected final SessionManager session;
    protected final EventBus eventBus;
    protected final Cancellation cancellation;
    protected final AppConfig config;

    protected BaseAgent(Executor executor, ToolsRegistry toolsRegistry,
                        SessionManager session, EventBus eventBus,
                        Cancellation cancellation, AppConfig config) {
        this.executor = executor;
        this.toolsRegistry = toolsRegistry;
        this.session = session;
        this.eventBus = eventBus;
        this.cancellation = cancellation;
        this.config = config;
    }

    public Flux<ExecutorEvent> chat(String sessionId, String userMessage) {
        cancellation.clear(sessionId);

        var prompt = buildPrompt(sessionId);
        session.appendMessage(sessionId, Map.of("role", "user", "content", userMessage));

        var messages = session.getHistory(sessionId);
        Executor.prepareMessages(messages);

        return executor.runLoop(sessionId, messages, prompt, config.model(), tools())
                .doOnNext(event -> {
                    if (event instanceof AgentAppendEvent ae) {
                        session.appendMessage(sessionId,
                                Map.of("role", ae.role(), "content", ae.content()));
                    } else if (event instanceof LlmEvent.Response resp) {
                        session.updateSessionMeta(sessionId, resp.usage().get("input_tokens"));
                    }
                });
    }

    protected abstract String persona();

    protected String memory() { return ""; }

    protected List<Map<String, Object>> tools() {
        return toolsRegistry.getTools();
    }

    /** System prompt used during reflection. Return null to skip reflection for this agent. */
    protected String reflectPrompt() { return null; }

    /** Tools available during reflection. Defaults to all tools. */
    protected List<Map<String, Object>> reflectTools() { return toolsRegistry.getTools(); }

    /**
     * Runs post-session reflection against the given transcript.
     * Returns a bullet summary of what was saved, or null if nothing / skipped.
     */
    public String reflect(String transcript) {
        var prompt = reflectPrompt();
        if (prompt == null || prompt.isBlank() || transcript.isBlank()) return null;

        var messages = List.<Map<String, Object>>of(
                Map.of("role", "user", "content", "Session transcript to reflect on:\n\n" + transcript));

        try {
            var summary = executor.runLoop("_reflect_" + getClass().getSimpleName(),
                            new ArrayList<>(messages), prompt, REFLECT_MODEL, reflectTools())
                    .filter(e -> e instanceof AgentAppendEvent ae && "assistant".equals(ae.role()))
                    .cast(AgentAppendEvent.class)
                    .flatMapIterable(AgentAppendEvent::content)
                    .filter(b -> b instanceof Map<?, ?> m && "text".equals(m.get("type")))
                    .map(b -> (String) ((Map<?, ?>) b).get("text"))
                    .reduce(String::concat)
                    .defaultIfEmpty("")
                    .block();

            if (summary != null && !summary.isBlank() && !"nothing to save".equalsIgnoreCase(summary.strip())) {
                return summary;
            }
        } catch (Exception e) {
            log.warn("{} reflection failed: {}", getClass().getSimpleName(), e.getMessage());
        }
        return null;
    }

    protected String buildPrompt(String sessionId) {
        eventBus.publish(Map.of("type", "boot_start"));

        var p = persona();
        if (!p.isEmpty()) {
            eventBus.publish(Map.of("type", "knowledge_file", "file", "instructions",
                    "label", "Instructions", "status", "loaded", "chars", p.length()));
        }

        var k = memory();
        if (!k.isEmpty()) {
            eventBus.publish(Map.of("type", "knowledge_file", "file", "memory",
                    "label", "Memory", "status", "loaded", "chars", k.length()));
        }

        var system = k.isEmpty() ? p : p + "\n\n" + k;

        var parentSummary = session.getParentSummary(sessionId);
        if (parentSummary.isPresent()) {
            var s = parentSummary.get();
            eventBus.publish(Map.of("type", "knowledge_file", "file", "last_session",
                    "label", "Last Session", "status", "loaded", "chars", s.content().length()));
            system += "\n\n# Session Context\n\n## Last Session — " + s.dateStr() + "\n\n" + s.content();
        }

        var now = ZonedDateTime.now().format(DateTimeFormatter.ofPattern("EEEE, MMMM d, yyyy h:mm a z"));
        system = system.strip() + "\n\n# Current Date & Time\n\n" + now;
        eventBus.publish(Map.of("type", "system_prompt", "chars", system.length()));
        eventBus.publish(Map.of("type", "boot_done"));
        return system;
    }
}
