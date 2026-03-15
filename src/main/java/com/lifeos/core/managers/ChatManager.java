package com.lifeos.core.managers;

import com.lifeos.core.helpers.EventBus;
import com.lifeos.core.helpers.Hooks;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.lifeos.core.agents.AgentAssistant;
import com.lifeos.core.agents.AgentTherapist;
import com.lifeos.core.managers.ReflectionManager;
import com.lifeos.core.agents.executor.Cancellation;
import com.lifeos.core.agents.executor.events.ExecutorEvent;
import com.lifeos.core.agents.executor.events.LlmEvent;
import com.lifeos.core.agents.executor.events.ToolEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Orchestrates an incoming message: rotation check, reflection, agent run, SSE serialization.
 */
@Component
public class ChatManager {

    private static final Logger log = LoggerFactory.getLogger(ChatManager.class);

    private final AgentAssistant assistantAgent;
    private final AgentTherapist therapistAgent;
    private final ReflectionManager reflectionManager;
    private final SessionManager session;
    private final Cancellation cancellation;
    private final Hooks hooks;
    private final EventBus eventBus;
    private final ObjectMapper mapper = new ObjectMapper();

    public ChatManager(AgentAssistant assistantAgent, AgentTherapist therapistAgent,
                       ReflectionManager reflectionManager,
                       SessionManager session, Cancellation cancellation, Hooks hooks, EventBus eventBus) {
        this.assistantAgent = assistantAgent;
        this.therapistAgent = therapistAgent;
        this.reflectionManager = reflectionManager;
        this.session = session;
        this.cancellation = cancellation;
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

    private Flux<ServerSentEvent<String>> handleInner(String sessionId, String message, String agent) {
        var rotation = session.checkRotation(sessionId);
        if (!rotation.shouldRotate()) {
            return runAgent(sessionId, message, agent);
        }

        var oldHistory = session.getHistory(sessionId);
        var rotatingSse = Flux.just(sse(Map.of("type", "session_rotating", "reason", rotation.reason())));

        return rotatingSse.concatWith(Mono.fromCallable(() -> {
            var summary = reflectionManager.run(sessionId, oldHistory);
            hooks.fire("on_reflection_done", Map.of("session_id", sessionId));
            return summary != null ? summary : "";
        }).subscribeOn(Schedulers.boundedElastic())
        .flatMapMany(summary -> {
            var newSessionId = session.rotate(sessionId);
            hooks.fire("on_session_rotate", Map.of(
                    "old_session_id", sessionId,
                    "new_session_id", newSessionId,
                    "reason", rotation.reason()));

            var reflectionSse = summary.isBlank() ? Flux.<ServerSentEvent<String>>empty()
                    : Flux.just(sse(Map.of("type", "reflection", "text", summary)));
            var rotateSse = Flux.just(sse(Map.of(
                    "type", "session_rotated",
                    "session_id", newSessionId,
                    "reason", rotation.reason())));

            return Flux.concat(reflectionSse, rotateSse, runAgent(newSessionId, message, agent));
        }));
    }

    private Flux<ServerSentEvent<String>> runAgent(String sessionId, String message, String agent) {
        hooks.fire("on_agent_start", Map.of("session_id", sessionId, "user_message", message));

        var stopped = new AtomicBoolean(false);
        var activeAgent = "therapist".equals(agent) ? therapistAgent : assistantAgent;

        return activeAgent.chat(sessionId, message)
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
                    var wasStopped = stopped.get() || cancellation.isCancelled(sessionId);
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
