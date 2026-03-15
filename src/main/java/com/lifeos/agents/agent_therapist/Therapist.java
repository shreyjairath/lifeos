package com.lifeos.agents.agent_therapist;

import com.lifeos.config.AppConfig;
import com.lifeos.core.EventBus;
import com.lifeos.core.Knowledge;
import com.lifeos.core.PromptParts;
import com.lifeos.core.SessionManager;
import com.lifeos.agents.executor.Cancellation;
import com.lifeos.agents.executor.Executor;
import com.lifeos.agents.executor.ToolsRegistry;
import com.lifeos.agents.executor.events.AgentAppendEvent;
import com.lifeos.agents.executor.events.ExecutorEvent;
import com.lifeos.agents.executor.events.LlmEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The therapist agent.
 *
 * Two modes:
 *   chat()    — user-facing conversation; reads therapist notes + session history, does not write notes
 *   reflect() — post-session background job; updates .user-data/therapist/ based on transcript
 */
@Component
public class Therapist {

    private static final Logger log = LoggerFactory.getLogger(Therapist.class);
    private static final String REFLECT_MODEL = "claude-haiku-4-5-20251001";
    private static final String PROMPT_BASE = "agents/agent_therapist";
    private static final String WHO_YOU_ARE_FILE = "who-you-are.md";
    private static final String INSTRUCTIONS_FILE = "instructions.md";
    private static final String REFLECT_FILE = "reflect.md";

    // Tools available during conversation — read-only on therapist notes + session recall
    private static final Set<String> CHAT_TOOLS = Set.of(
            "list_therapist_notes", "read_therapist_note", "grep_therapist_notes",
            "list_sessions", "read_session_summary", "read_session_transcript",
            "get_current_datetime");

    // Tools available during reflection — full write access to therapist notes
    private static final Set<String> REFLECT_TOOLS = Set.of(
            "list_therapist_notes", "read_therapist_note", "write_therapist_note",
            "delete_therapist_note", "grep_therapist_notes", "get_current_datetime");

    private final Executor executor;
    private final ToolsRegistry toolsRegistry;
    private final Knowledge knowledge;
    private final SessionManager session;
    private final EventBus eventBus;
    private final Cancellation cancellation;
    private final AppConfig config;

    public Therapist(Executor executor, ToolsRegistry toolsRegistry,
                     Knowledge knowledge, SessionManager session, EventBus eventBus,
                     Cancellation cancellation, AppConfig config) {
        this.executor = executor;
        this.toolsRegistry = toolsRegistry;
        this.knowledge = knowledge;
        this.session = session;
        this.eventBus = eventBus;
        this.cancellation = cancellation;
        this.config = config;
    }

    // ── Conversational mode ───────────────────────────────────────────────────

    public Flux<ExecutorEvent> chat(String sessionId, String userMessage) {
        cancellation.clear(sessionId);

        var persona = PromptParts.load(PROMPT_BASE, WHO_YOU_ARE_FILE) + "\n\n"
                + PromptParts.load(PROMPT_BASE, INSTRUCTIONS_FILE);
        var prompt = buildPrompt(sessionId, persona);
        session.appendMessage(sessionId, Map.of("role", "user", "content", userMessage));

        var messages = session.getHistory(sessionId);
        Executor.prepareMessages(messages);

        var tools = toolsRegistry.getTools().stream()
                .filter(t -> CHAT_TOOLS.contains(t.get("name")))
                .toList();

        return executor.runLoop(sessionId, messages, prompt, config.model(), tools)
                .doOnNext(event -> {
                    if (event instanceof AgentAppendEvent ae) {
                        session.appendMessage(sessionId,
                                Map.of("role", ae.role(), "content", ae.content()));
                    } else if (event instanceof LlmEvent.Response resp) {
                        session.updateSessionMeta(sessionId, resp.usage().get("input_tokens"));
                    }
                });
    }

    // ── Reflection mode ───────────────────────────────────────────────────────

    public String reflect(String transcript) {
        if (transcript.isBlank()) return null;

        var tools = toolsRegistry.getTools().stream()
                .filter(t -> REFLECT_TOOLS.contains(t.get("name")))
                .toList();

        var messages = List.<Map<String, Object>>of(
                Map.of("role", "user", "content", "Session transcript to reflect on:\n\n" + transcript));

        try {
            var reflectPrompt = PromptParts.load(PROMPT_BASE, WHO_YOU_ARE_FILE) + "\n\n"
                    + PromptParts.load(PROMPT_BASE, REFLECT_FILE);
            var summary = executor.runLoop("_reflect_therapist", new ArrayList<>(messages),
                            reflectPrompt, REFLECT_MODEL, tools)
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
            log.warn("Therapist reflection failed: {}", e.getMessage());
        }
        return null;
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private String buildPrompt(String sessionId, String persona) {
        eventBus.publish(Map.of("type", "boot_start"));

        var system = persona + "\n\n" + knowledge.getKnowledgeSection();

        var parentSummary = session.getParentSummary(sessionId);
        if (parentSummary.isPresent()) {
            var s = parentSummary.get();
            eventBus.publish(Map.of("type", "knowledge_file", "file", "last_session",
                    "label", "Last Session", "status", "loaded", "chars", s.content().length()));
            system += "\n\n# Session Context\n\n## Last Session — " + s.dateStr() + "\n\n" + s.content();
        }

        system = system.strip();
        eventBus.publish(Map.of("type", "system_prompt", "chars", system.length()));
        eventBus.publish(Map.of("type", "boot_done"));
        return system;
    }
}
