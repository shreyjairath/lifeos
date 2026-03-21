package com.lifeos.core.managers;

import com.lifeos.core.helpers.EventBus;
import com.lifeos.core.helpers.Hooks;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.lifeos.core.managers.AgentRegistry;
import com.lifeos.core.agent.SessionHandler;
import com.lifeos.core.executor.events.ExecutorEvent;
import com.lifeos.core.executor.events.LlmEvent;
import com.lifeos.core.executor.events.ToolEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;

import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Orchestrates an incoming message: rotation check, agent run, SSE serialization.
 * On session rotation, publishes `session_closed` — agents and SessionSummarizer react independently.
 */
@Component
public class ChatManager {

    private static final Logger log = LoggerFactory.getLogger(ChatManager.class);

    private final AgentRegistry agentRegistry;
    private final Hooks hooks;
    private final EventBus eventBus;
    private final ObjectMapper mapper = new ObjectMapper();

    public ChatManager(
        AgentRegistry agentRegistry,
        Hooks hooks, 
        EventBus eventBus
    ) {
        this.agentRegistry = agentRegistry;
        this.hooks = hooks;
        this.eventBus = eventBus;
    }

    public Flux<ServerSentEvent<String>> handleMessage(String sessionId, String message, String agent) {
        return handleInner(sessionId, message, agent)
                .onErrorResume(e -> {
                    log.error("Error handling message", e);
                    eventBus.publish(Map.of("type", "error", "text", e.getMessage()));
                    return Flux.just(sse(Map.of(
                            "type", "error",
                            "text", e.getMessage() != null ? e.getMessage() : "Unknown error"
                    )));
                });
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private Flux<ServerSentEvent<String>> handleInner(String sessionId, String message, String agentName) {
        var agent = agentRegistry.get(agentName);
        var rotation = agent.getSessionHandler().checkRotation(sessionId);
        if (!rotation.shouldRotate()) {
            return runAgent(sessionId, message, agentName);
        }

        hooks.fire("on_reflection_done", Map.of("session_id", sessionId));
        var newSessionId = agent.getSessionHandler().rotate(sessionId); // emits session_closed internally
        hooks.fire("on_session_rotate", Map.of(
                "old_session_id", sessionId,
                "new_session_id", newSessionId,
                "reason", rotation.reason()));

        return Flux.concat(
                Flux.just(sse(Map.of("type", "session_rotating", "reason", rotation.reason()))),
                Flux.just(sse(Map.of("type", "session_rotated", "session_id", newSessionId, "reason", rotation.reason()))),
                runAgent(newSessionId, message, agentName));
    }

    private Flux<ServerSentEvent<String>> runAgent(String sessionId, String message, String agentName) {
        hooks.fire("on_agent_start", Map.of("session_id", sessionId, "user_message", message));

        var agent = agentRegistry.get(agentName);
        var stopped = new AtomicBoolean(false);
        
        return agent.handleUserMessage(sessionId, message)
                .doOnNext(event -> {
                    if (event instanceof LlmEvent.Response resp) {
                        hooks.fire("on_llm_response", Map.of(
                                "session_id", sessionId,
                                "input_tokens", resp.usage().get("input_tokens"),
                                "output_tokens", resp.usage().get("output_tokens"),
                                "stop_reason", resp.stopReason()));
                    } else if (event instanceof ToolEvent.Cancelled) {
                        stopped.set(true);
                    }
                })
                .mapNotNull(this::toSse)
                .concatWith(Flux.defer(() -> {
                    var wasStopped = stopped.get();
                    hooks.fire("on_agent_done", Map.of("session_id", sessionId, "stopped", wasStopped));
                    return Flux.just(sse(Map.of("type", wasStopped ? "stopped" : "done")));
                }));
    }

    private ServerSentEvent<String> toSse(ExecutorEvent event) {
        Map<String, Object> payload = switch (event) {
            case LlmEvent.Request r -> Map.of("type", "request_json", "payload",
                    Map.of("model", r.model(), "max_tokens", r.maxTokens(),
                            "system", r.system(), "messages", r.messages(), "tools", r.tools()));
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
}
