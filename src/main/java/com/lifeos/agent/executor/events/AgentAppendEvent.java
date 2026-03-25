package com.lifeos.agent.executor.events;

import java.util.Map;

/**
 * Signals the caller to append a message to persistent history.
 * The message is a complete OpenAI-format message map.
 */
public record AgentAppendEvent(Map<String, Object> message) implements ExecutorEvent {
    public String role() { return (String) message.get("role"); }
}
