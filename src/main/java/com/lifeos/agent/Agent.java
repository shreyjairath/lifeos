package com.lifeos.agent;

import com.lifeos.agent.executor.events.ExecutorEvent;
import com.lifeos.agent.session.SessionHandler;
import reactor.core.publisher.Flux;

public interface Agent {
    String getName();
    String getTitle();
    String getDescription();
    AgentDefinition getDefinition();
    SessionHandler getSessionHandler();
    void cancel(String sessionId);
    Flux<ExecutorEvent> handleUserMessage(String sessionId, String message, String modelOverride);
    void handleAgentMessageAsync(String fromAgent, String content);
    String handleAgentMessage(String fromAgent, String content);
}
