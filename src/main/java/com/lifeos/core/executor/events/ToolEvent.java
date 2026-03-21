package com.lifeos.core.executor.events;

import java.util.Map;

/**
 * Events emitted by the tools client during tool invocation.
 */
public sealed interface ToolEvent extends ExecutorEvent
        permits ToolEvent.ConfirmRequest, ToolEvent.ConfirmDenied,
                ToolEvent.Result, ToolEvent.Cancelled {

    record ConfirmRequest(
        String requestId,
        String name,
        Map<String, Object> input
    ) implements ToolEvent {}

    record ConfirmDenied(String name) implements ToolEvent {}

    record Result(String name, Map<String, Object> result) implements ToolEvent {}

    record Cancelled() implements ToolEvent {}
}
