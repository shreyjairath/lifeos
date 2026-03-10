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
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Conversation manager: handles an incoming message end-to-end.
 * Owns session lifecycle, history, system prompt assembly, SSE serialization.
 */
@Component
public class ConversationManager {

    private static final Logger log = LoggerFactory.getLogger(ConversationManager.class);

    private final Executor executor;
    private final Session session;
    private final Knowledge knowledge;
    private final SystemPrompt systemPrompt;
    private final Cancellation cancellation;
    private final Hooks hooks;
    private final EventBus eventBus;
    private final AppConfig config;
    private final ObjectMapper mapper = new ObjectMapper();

    public ConversationManager(Executor executor, Session session, Knowledge knowledge,
                               SystemPrompt systemPrompt, Cancellation cancellation, Hooks hooks,
                               EventBus eventBus, AppConfig config) {
        this.executor = executor;
        this.session = session;
        this.knowledge = knowledge;
        this.systemPrompt = systemPrompt;
        this.cancellation = cancellation;
        this.hooks = hooks;
        this.eventBus = eventBus;
        this.config = config;
    }

    /**
     * Public entry point for an incoming user message. Delegates to {@link #handleInner} and
     * wraps the stream with a top-level error handler that emits an SSE error event on failure.
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

    /**
     * Core message handler. Checks whether the current session needs rotation before running the
     * agent. If rotation is due, runs reflection (KB update, session archive, conv summary) on a
     * bounded-elastic thread, creates a new session, and emits rotation SSE events before
     * forwarding the pending message to the new session. If no rotation is needed, runs the agent
     * directly.
     */
    private Flux<ServerSentEvent<String>> handleInner(
            String convId, String sessionId, String message
    ) {
        var rotation = session.checkRotation(convId, sessionId);
        if (!rotation.shouldRotate()) {
            return runAgent(convId, sessionId, message);
        }

        var oldHistory = session.getHistory(convId, sessionId);
        var rotatingSse = Flux.just(sse(Map.of("type", "session_rotating", "reason", rotation.reason())));
        return rotatingSse.concatWith(Mono.fromCallable(() -> {
                    var transcript = Session.buildTranscript(oldHistory);
                    if (message != null && !message.isEmpty()) {
                        transcript += "\n\nUSER (pending — triggered session rotation): " + message;
                    }
                    if (transcript.isEmpty()) return "";
                    var summary = knowledge.reflect(oldHistory, convId, sessionId);
                    session.reflect(convId, transcript);
                    hooks.fire("on_reflection_done", Map.of("conv_id", convId, "session_id", sessionId));
                    return summary != null ? summary : "";
                }).subscribeOn(Schedulers.boundedElastic())
                .flatMapMany(summary -> {
                    var newSession = session.newSession(convId);
                    hooks.fire("on_session_rotate", Map.of(
                            "conv_id", convId, "old_session_id", sessionId,
                            "new_session_id", newSession, "reason", rotation.reason()));

                    var reflectionSse = summary.isBlank() ? Flux.<ServerSentEvent<String>>empty()
                            : Flux.just(sse(Map.of("type", "reflection", "text", summary)));
                    var rotateSse = Flux.just(sse(Map.of(
                            "type", "session_rotated", "session_id", newSession,
                            "reason", rotation.reason())));

                    return Flux.concat(reflectionSse, rotateSse, runAgent(convId, newSession, message));
                }));
    }

    /**
     * Appends the user message to history, assembles the system prompt, and runs the executor's
     * agentic loop. Persists each assistant/tool turn as it arrives, tracks token usage, and
     * emits a terminal {@code done} or {@code stopped} SSE event when the loop completes.
     */
    @SuppressWarnings("unchecked")
    private Flux<ServerSentEvent<String>> runAgent(String convId, String sessionId, String message) {
        cancellation.clear(sessionId);
        hooks.fire("on_agent_start", Map.of(
                "conv_id", convId, "session_id", sessionId, "user_message", message));

        var prompt = systemPrompt.prepare(convId);
        session.appendMessage(convId, sessionId, Map.of("role", "user", "content", message));

        var messages = session.getHistory(convId, sessionId);
        Executor.prepareMessages(messages);

        var stopped = new AtomicBoolean(false);

        return executor.runLoop(sessionId, messages, prompt, config.model())
                .doOnNext(event -> {
                    if (event instanceof AgentAppendEvent ae) {
                        session.appendMessage(convId, sessionId,
                                Map.of("role", ae.role(), "content", ae.content()));
                    } else if (event instanceof LlmEvent.Response resp) {
                        session.updateSessionMeta(convId, sessionId, resp.usage().get("input_tokens"));
                        hooks.fire("on_llm_response", Map.of(
                                "conv_id", convId, "session_id", sessionId,
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
                    hooks.fire("on_agent_done", Map.of(
                            "conv_id", convId, "session_id", sessionId, "stopped", wasStopped));
                    return Flux.just(sse(Map.of("type", wasStopped ? "stopped" : "done")));
                }));
    }

    /**
     * Maps a typed {@link ExecutorEvent} to an SSE payload map, or returns {@code null} for events
     * that should not be forwarded to the client (e.g. internal cancellation signals). Used with
     * {@code mapNotNull} so null results are silently dropped from the stream.
     */
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

    /** Serializes {@code data} to JSON and wraps it in a {@link ServerSentEvent}. */
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
