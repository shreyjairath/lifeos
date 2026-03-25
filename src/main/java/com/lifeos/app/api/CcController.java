package com.lifeos.app.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.lifeos.config.AppConfig;
import com.lifeos.agent.executor.LlmClient;
import com.lifeos.agent.executor.events.LlmEvent;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Flux;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Claude Code sidecar chat — a developer assistant scoped to the lifeos codebase.
 * Maintains in-memory session history; no file persistence.
 */
@RestController
@RequestMapping("/api/cc")
public class CcController {

    private static final String SYSTEM = """
            You are Claude Code, a developer assistant embedded in the lifeos personal agent application.
            You help the developer understand, debug, and extend the lifeos codebase.
            The backend is Spring Boot 3 + WebFlux (Java 25). The frontend is vanilla JS with ES modules.
            Be concise and precise. Prefer code examples over lengthy explanations.
            """;

    // sessionId -> ordered list of {role, content} messages
    private final ConcurrentHashMap<String, List<Map<String, Object>>> sessions = new ConcurrentHashMap<>();

    private final LlmClient llmClient;
    private final String model;
    private final ObjectMapper mapper = new ObjectMapper();

    public CcController(AppConfig config) {
        this.llmClient = new LlmClient(config.apiKey());
        this.model = config.model();
    }

    @PostMapping(value = "/chat", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> chat(@RequestBody Map<String, Object> body) {
        var message = (String) body.get("message");
        var sessionId = (String) body.getOrDefault("session_id", null);
        if (sessionId == null || sessionId.isBlank()) {
            sessionId = "cc-" + UUID.randomUUID().toString().substring(0, 8);
        }
        final var sid = sessionId;

        var history = sessions.computeIfAbsent(sid, k -> new ArrayList<>());
        history.add(Map.of("role", "user", "content", message));

        var result = new LlmClient.LlmResult();
        var messages = new ArrayList<>(history);  // snapshot

        return llmClient.stream(model, SYSTEM, messages, List.of(), result)
                .flatMap(event -> {
                    if (event instanceof LlmEvent.Text(var text)) {
                        var data = toJson(Map.of("type", "cc_block",
                                "block", Map.of("type", "text", "text", text)));
                        return Flux.just(sse(data));
                    }
                    return Flux.empty();
                })
                .concatWith(Flux.defer(() -> {
                    // Persist assistant reply and emit session_id
                    var fullText = result.getFullText();
                    if (!fullText.isBlank()) {
                        history.add(Map.of("role", "assistant", "content", fullText));
                    }
                    var sidEvent = sse(toJson(Map.of("type", "session_id", "session_id", sid)));
                    return Flux.just(sidEvent);
                }))
                .onErrorResume(e -> {
                    var errData = toJson(Map.of("type", "error", "text", e.getMessage()));
                    return Flux.just(sse(errData));
                });
    }

    @GetMapping("/history")
    public Map<String, Object> history(@RequestParam("session_id") String sessionId) {
        var history = sessions.getOrDefault(sessionId, List.of());
        var messages = new ArrayList<Map<String, Object>>();
        for (var msg : history) {
            var role = (String) msg.get("role");
            var content = msg.get("content");
            var text = content instanceof String s ? s
                    : content instanceof List<?> list && !list.isEmpty()
                      && list.get(0) instanceof Map<?,?> m ? (String) m.get("text") : "";
            messages.add(Map.of("role", role.equals("assistant") ? "cc" : role, "text", text));
        }
        return Map.of("messages", messages);
    }

    private static ServerSentEvent<String> sse(String data) {
        return ServerSentEvent.<String>builder().data(data).build();
    }

    private String toJson(Object obj) {
        try { return mapper.writeValueAsString(obj); }
        catch (Exception e) { return "{}"; }
    }
}
