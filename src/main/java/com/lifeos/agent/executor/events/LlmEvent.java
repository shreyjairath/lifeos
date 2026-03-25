package com.lifeos.agent.executor.events;

import java.util.List;
import java.util.Map;

/**
 * Events emitted by the LLM client during streaming.
 */
public sealed interface LlmEvent extends ExecutorEvent
        permits LlmEvent.Request, LlmEvent.Text, LlmEvent.Reasoning, LlmEvent.ToolCall, LlmEvent.Response {

    record Request(
        String model,
        int maxTokens,
        String system,
        List<Map<String, Object>> messages,
        List<Map<String, Object>> tools
    ) implements LlmEvent {}

    record Text(String text) implements LlmEvent {}

    record Reasoning(String text) implements LlmEvent {}

    record ToolCall(String name, Map<String, Object> input) implements LlmEvent {}

    record Response(
        String stopReason,
        Map<String, Integer> usage,
        List<Map<String, Object>> content
    ) implements LlmEvent {}
}
