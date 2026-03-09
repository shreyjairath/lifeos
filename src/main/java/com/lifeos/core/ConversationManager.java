package com.lifeos.core;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.lifeos.config.AppConfig;
import com.lifeos.executor.Cancellation;
import com.lifeos.executor.Executor;
import com.lifeos.executor.events.AgentAppendEvent;
import com.lifeos.executor.events.ExecutorEvent;
import com.lifeos.executor.events.LlmEvent;
import com.lifeos.executor.events.ToolEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Conversation manager: handles an incoming message end-to-end.
 * Owns session lifecycle, history, system prompt assembly, SSE serialization.
 */
@Component
public class ConversationManager {

    private static final Logger log = LoggerFactory.getLogger(ConversationManager.class);

    private final Executor executor;
    private final Memory memory;
    private final Knowledge knowledge;
    private final Reflection reflection;
    private final Cancellation cancellation;
    private final Hooks hooks;
    private final EventBus eventBus;
    private final AppConfig config;
    private final ObjectMapper mapper = new ObjectMapper();

    public ConversationManager(Executor executor, Memory memory, Knowledge knowledge,
                               Reflection reflection, Cancellation cancellation, Hooks hooks,
                               EventBus eventBus, AppConfig config) {
        this.executor = executor;
        this.memory = memory;
        this.knowledge = knowledge;
        this.reflection = reflection;
        this.cancellation = cancellation;
        this.hooks = hooks;
        this.eventBus = eventBus;
        this.config = config;
    }

    /**
     * Entry point for a user message. Returns SSE stream.
     */
    public Flux<ServerSentEvent<String>> handleMessage(
            String convId, String sessionId, String message
    ) {
        return handleInner(convId, sessionId, message)
                .onErrorResume(e -> {
                    log.error("Error handling message", e);
                    eventBus.publish(Map.of("type", "error", "text", e.getMessage()));
                    return Flux.just(sse(Map.of(
                            "type", "error",
                            "text", e.getMessage() != null ? e.getMessage() : "Unknown error"
                    )));
                });
    }


    // ── Internal ─────────────────────────────────────────────────────────────────

    private Flux<ServerSentEvent<String>> handleInner(
            String convId, String sessionIdParam, String message
    ) {
        // Rotation check
        var rotation = checkRotation(convId, sessionIdParam);
        var needsRotation = rotation.shouldRotate();
        var reason = rotation.reason();

        return Flux.defer(() -> {
            String sessionId = sessionIdParam;

            if (needsRotation) {
                var oldHistory = memory.getHistory(convId, sessionId);
                // Run reflection synchronously (it blocks on LLM calls)
                var summary = reflection.rotationReflect(convId, oldHistory, message, sessionId).block();

                var preEvents = Flux.<ServerSentEvent<String>>empty();
                if (summary != null) {
                    preEvents = Flux.just(sse(Map.of("type", "reflection", "text", summary)));
                }

                sessionId = memory.newSession(convId);
                var rotateEvent = sse(Map.of(
                        "type", "session_rotated", "session_id", sessionId, "reason", reason));
                hooks.fire("on_session_rotate", Map.of(
                        "conv_id", convId, "old_session_id", sessionIdParam,
                        "new_session_id", sessionId, "reason", reason));

                var finalSessionId = sessionId;
                return Flux.concat(preEvents, Flux.just(rotateEvent),
                        runAgent(convId, finalSessionId, message));
            }

            return runAgent(convId, sessionId, message);
        });
    }

    @SuppressWarnings("unchecked")
    private Flux<ServerSentEvent<String>> runAgent(String convId, String sessionId, String message) {
        cancellation.clear(sessionId);
        hooks.fire("on_agent_start", Map.of(
                "conv_id", convId, "session_id", sessionId, "user_message", message));

        var systemPrompt = knowledge.prepareSystemPrompt(convId);
        memory.appendMessage(convId, sessionId, Map.of("role", "user", "content", message));

        var messages = memory.getHistory(convId, sessionId);
        Executor.prepareMessages(messages);

        var stopped = new boolean[]{false};

        return executor.runLoop(sessionId, messages, systemPrompt, config.model())
                .doOnNext(event -> {
                    if (event instanceof AgentAppendEvent ae) {
                        memory.appendMessage(convId, sessionId,
                                Map.of("role", ae.role(), "content", ae.content()));
                    } else if (event instanceof LlmEvent.Response resp) {
                        memory.updateSessionMeta(convId, sessionId, resp.usage().get("input_tokens"));
                        hooks.fire("on_llm_response", Map.of(
                                "conv_id", convId, "session_id", sessionId,
                                "input_tokens", resp.usage().get("input_tokens"),
                                "output_tokens", resp.usage().get("output_tokens"),
                                "stop_reason", resp.stopReason()));
                    } else if (event instanceof ToolEvent.Cancelled) {
                        stopped[0] = true;
                    }
                })
                .mapNotNull(this::toSse)
                .concatWith(Flux.defer(() -> {
                    if (!stopped[0]) {
                        stopped[0] = cancellation.isCancelled(sessionId);
                    }
                    hooks.fire("on_agent_done", Map.of(
                            "conv_id", convId, "session_id", sessionId, "stopped", stopped[0]));
                    if (stopped[0]) {
                        return Flux.just(sse(Map.of("type", "stopped")));
                    }
                    return Flux.just(sse(Map.of("type", "done")));
                }));
    }

    private RotationCheck checkRotation(String convId, String sessionId) {
        var tokenThreshold = config.session().tokenThreshold();
        var timeThresholdHours = config.session().timeThresholdHours();

        var meta = memory.getSessionMeta(convId, sessionId);
        if (meta.isEmpty()) return new RotationCheck(false, "");

        var lastInputTokens = meta.containsKey("last_input_tokens")
                ? ((Number) meta.get("last_input_tokens")).intValue() : 0;
        if (lastInputTokens >= tokenThreshold) {
            return new RotationCheck(true,
                    "context window (%,d input tokens)".formatted(lastInputTokens));
        }

        if (meta.containsKey("last_message_at")) {
            var lastMsg = ((Number) meta.get("last_message_at")).doubleValue();
            var elapsed = Instant.now().getEpochSecond() - lastMsg;
            if (elapsed >= timeThresholdHours * 3600) {
                return new RotationCheck(true,
                        "inactivity (%.0fh since last message)".formatted(elapsed / 3600));
            }
        }

        return new RotationCheck(false, "");
    }

    private ServerSentEvent<String> toSse(ExecutorEvent event) {
        Map<String, Object> payload = switch (event) {
            case LlmEvent.Request r -> Map.of("type", "request_json", "payload",
                    Map.of("model", r.model(), "max_tokens", r.maxTokens(),
                            "messages", r.messageCount(), "system", r.system()));
            case LlmEvent.Text t -> Map.of("type", "text", "text", t.text());
            case LlmEvent.ToolCall tc -> Map.of("type", "tool_call", "name", tc.name(), "input", tc.input());
            case LlmEvent.Response r -> Map.of("type", "response_json", "payload",
                    Map.of("stop_reason", r.stopReason(), "usage", r.usage(), "content", r.content()));
            case ToolEvent.ConfirmRequest cr -> Map.of("type", "tool_confirm_request",
                    "request_id", cr.requestId(), "name", cr.name(), "input", cr.input());
            case ToolEvent.ConfirmDenied cd -> Map.of("type", "tool_confirm_denied", "name", cd.name());
            case ToolEvent.Result tr -> Map.of("type", "tool_result", "name", tr.name(), "result", tr.result());
            default -> null;
        };
        if (payload == null) return null;
        return sse(payload);
    }

    private ServerSentEvent<String> sse(Map<String, Object> data) {
        try {
            return ServerSentEvent.<String>builder()
                    .data(mapper.writeValueAsString(data))
                    .build();
        } catch (JsonProcessingException e) {
            return ServerSentEvent.<String>builder()
                    .data("{\"type\":\"error\",\"text\":\"serialization error\"}")
                    .build();
        }
    }

    private record RotationCheck(boolean shouldRotate, String reason) {}
}
