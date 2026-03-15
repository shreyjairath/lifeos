package com.lifeos.agents;

import com.lifeos.config.AppConfig;
import com.lifeos.core.EventBus;
import com.lifeos.core.Knowledge;
import com.lifeos.core.PromptParts;
import com.lifeos.core.SessionManager;
import com.lifeos.agents.executor.Cancellation;
import com.lifeos.agents.executor.Executor;
import com.lifeos.agents.executor.events.AgentAppendEvent;
import com.lifeos.agents.executor.events.ExecutorEvent;
import com.lifeos.agents.executor.events.LlmEvent;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;

import java.util.Map;

/**
 * The main user-facing assistant agent.
 * Self-contained: owns its model, system prompt assembly, session persistence, and executor loop.
 */
@Component
public class AssistantAgent {

    private final Executor executor;
    private final Knowledge knowledge;
    private final SessionManager session;
    private final EventBus eventBus;
    private final Cancellation cancellation;
    private final AppConfig config;

    public AssistantAgent(Executor executor, Knowledge knowledge,
                          SessionManager session, EventBus eventBus,
                          Cancellation cancellation, AppConfig config) {
        this.executor = executor;
        this.knowledge = knowledge;
        this.session = session;
        this.eventBus = eventBus;
        this.cancellation = cancellation;
        this.config = config;
    }

    public Flux<ExecutorEvent> run(String sessionId, String userMessage) {
        cancellation.clear(sessionId);

        var prompt = buildPrompt(sessionId, PromptParts.load(PromptParts.loadActiveInstructions()));
        session.appendMessage(sessionId, Map.of("role", "user", "content", userMessage));

        var messages = session.getHistory(sessionId);
        Executor.prepareMessages(messages);

        return executor.runLoop(sessionId, messages, prompt, config.model())
                .doOnNext(event -> {
                    if (event instanceof AgentAppendEvent ae) {
                        session.appendMessage(sessionId,
                                Map.of("role", ae.role(), "content", ae.content()));
                    } else if (event instanceof LlmEvent.Response resp) {
                        session.updateSessionMeta(sessionId, resp.usage().get("input_tokens"));
                    }
                });
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
