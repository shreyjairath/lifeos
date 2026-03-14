package com.lifeos.agents;

import com.lifeos.config.AppConfig;
import com.lifeos.core.SessionManager;
import com.lifeos.core.SystemPrompt;
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
    private final SystemPrompt systemPrompt;
    private final SessionManager session;
    private final Cancellation cancellation;
    private final AppConfig config;

    public AssistantAgent(Executor executor, SystemPrompt systemPrompt,
                          SessionManager session, Cancellation cancellation, AppConfig config) {
        this.executor = executor;
        this.systemPrompt = systemPrompt;
        this.session = session;
        this.cancellation = cancellation;
        this.config = config;
    }

    /**
     * Runs the assistant agent for a user message.
     * Appends the user message, builds the system prompt, runs the agentic loop,
     * and persists assistant + tool messages back to the session.
     */
    public Flux<ExecutorEvent> run(String sessionId, String userMessage) {
        cancellation.clear(sessionId);

        var prompt = systemPrompt.prepare(sessionId);
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
}
