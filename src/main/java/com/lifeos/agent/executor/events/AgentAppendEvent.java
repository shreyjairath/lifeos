package com.lifeos.agent.executor.events;

import java.util.List;
import java.util.Map;

/**
 * Signals the caller to append a message to persistent history.
 */
public record AgentAppendEvent(
    String role,
    List<Map<String, Object>> content
) implements ExecutorEvent {}
