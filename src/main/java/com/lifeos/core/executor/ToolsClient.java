package com.lifeos.core.executor;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.lifeos.core.executor.events.ToolEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import reactor.core.publisher.Flux;
import reactor.core.publisher.FluxSink;

import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.BooleanSupplier;

/**
 * Tool invocation, gating, and cancellation.
 */
class ToolsClient {

    private static final Logger log = LoggerFactory.getLogger(ToolsClient.class);

    private final Confirmations confirmations;
    private final ObjectMapper mapper;
    private final ExecutorService toolExecutor;

    ToolsClient(Confirmations confirmations) {
        this.confirmations = confirmations;
        this.mapper = new ObjectMapper();
        this.toolExecutor = Executors.newVirtualThreadPerTaskExecutor();
    }

    Flux<ToolEvent> invoke(
            List<Map<String, Object>> toolUses,
            BooleanSupplier isCancelled,
            ToolsResult result,
            String agentName,
            ToolInvoker dispatch
    ) {
        return Flux.create(sink -> {
            toolExecutor.submit(() -> {
                try {
                    for (int i = 0; i < toolUses.size(); i++) {
                        if (sink.isCancelled()) return;

                        if (isCancelled.getAsBoolean()) {
                            stubTools(toolUses.subList(i, toolUses.size()), result, "Cancelled by user");
                            result.setCancelled(true);
                            sink.next(new ToolEvent.Cancelled());
                            sink.complete();
                            return;
                        }

                        invokeOne(toolUses.get(i), result, sink, agentName, dispatch);
                    }
                    sink.complete();
                } catch (Exception e) {
                    stubUndispatched(toolUses, result, e);
                    sink.error(e);
                }
            });
        });
    }

    // ── Private ──────────────────────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    private void invokeOne(Map<String, Object> toolUse, ToolsResult result, FluxSink<ToolEvent> sink, String agentName, ToolInvoker dispatch) {
        var name  = (String) toolUse.get("name");
        var id    = (String) toolUse.get("id");
        var input = (Map<String, Object>) toolUse.get("input");

        Map<String, Object> toolResult;

        if (confirmations.isGated(name)) {
            var reqId = confirmations.register();
            sink.next(new ToolEvent.ConfirmRequest(reqId, name, input));
            boolean approved = confirmations.waitFor(reqId);
            if (!approved) {
                toolResult = Map.of("error", "User denied execution of " + name);
                sink.next(new ToolEvent.ConfirmDenied(name));
                appendResult(id, toolResult, result);
                return;
            }
        }

        toolResult = dispatch.invoke(name, input, agentName);
        appendResult(id, toolResult, result);
        sink.next(new ToolEvent.Result(name, toolResult));
    }

    private void appendResult(String toolUseId, Map<String, Object> toolResult, ToolsResult result) {
        String content;
        try {
            content = mapper.writeValueAsString(toolResult);
        } catch (JsonProcessingException e) {
            content = "{\"error\":\"Failed to serialize tool result\"}";
        }
        result.addMessage(Map.of(
                "type", "tool_result",
                "tool_use_id", toolUseId,
                "content", content
        ));
    }

    private void stubTools(List<Map<String, Object>> toolUses, ToolsResult result, String error) {
        for (var toolUse : toolUses) {
            String content;
            try {
                content = mapper.writeValueAsString(Map.of("error", error));
            } catch (JsonProcessingException e) {
                content = "{\"error\":\"" + error + "\"}";
            }
            result.addMessage(Map.of(
                    "type", "tool_result",
                    "tool_use_id", toolUse.get("id"),
                    "content", content
            ));
        }
    }

    private void stubUndispatched(List<Map<String, Object>> toolUses, ToolsResult result, Exception exc) {
        var dispatchedIds = new HashSet<String>();
        for (var msg : result.getMessages()) dispatchedIds.add((String) msg.get("tool_use_id"));
        var undispatched = toolUses.stream().filter(t -> !dispatchedIds.contains(t.get("id"))).toList();
        var errorMsg = exc.getMessage();
        stubTools(undispatched, result, errorMsg != null && !errorMsg.isEmpty() ? errorMsg : "Interrupted");
    }

    // ── Result type ──────────────────────────────────────────────────────────────

    static class ToolsResult {
        private final List<Map<String, Object>> messages = Collections.synchronizedList(new ArrayList<>());
        private volatile boolean cancelled = false;

        List<Map<String, Object>> getMessages() { return messages; }
        void addMessage(Map<String, Object> msg) { messages.add(msg); }
        boolean isCancelled() { return cancelled; }
        void setCancelled(boolean cancelled) { this.cancelled = cancelled; }
    }
}
