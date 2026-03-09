package com.lifeos.executor.events;

import java.util.List;
import java.util.Map;

/**
 * Events emitted by the LLM client during streaming.
 */
public sealed interface LlmEvent extends ExecutorEvent
        permits LlmEvent.Request, LlmEvent.Text, LlmEvent.ToolCall, LlmEvent.Response {

    record Request(
        String model,
        int maxTokens,
        int messageCount,
        String system
    ) implements LlmEvent {}

    record Text(String text) implements LlmEvent {}

    record ToolCall(String name, Map<String, Object> input) implements LlmEvent {}

    record Response(
        String stopReason,
        Map<String, Integer> usage,
        List<Map<String, Object>> content
    ) implements LlmEvent {}
}
