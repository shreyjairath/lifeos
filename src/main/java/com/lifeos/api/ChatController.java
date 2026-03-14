package com.lifeos.api;

import com.lifeos.api.dto.ChatRequest;
import com.lifeos.core.ChatManager;
import com.lifeos.core.SessionManager;
import com.lifeos.agents.executor.Cancellation;
import com.lifeos.agents.executor.Confirmations;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Flux;

import java.util.Map;

@RestController
@RequestMapping("/api")
public class ChatController {

    private final ChatManager chatManager;
    private final SessionManager session;
    private final Cancellation cancellation;
    private final Confirmations confirmations;

    public ChatController(ChatManager chatManager, SessionManager session,
                          Cancellation cancellation, Confirmations confirmations) {
        this.chatManager = chatManager;
        this.session = session;
        this.cancellation = cancellation;
        this.confirmations = confirmations;
    }

    @PostMapping(value = "/chat", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> chat(@RequestBody ChatRequest request) {
        return chatManager.handleMessage(request.sessionId(), request.message());
    }

    @GetMapping("/chat/{sessionId}")
    public Map<String, Object> getChatHistory(@PathVariable String sessionId) {
        return session.getDisplayHistory(sessionId);
    }

    @DeleteMapping("/chat/{sessionId}")
    public Map<String, String> clearChat(@PathVariable String sessionId) {
        session.clearSession(sessionId);
        return Map.of("cleared", sessionId);
    }

    @PostMapping("/chat/{sessionId}/truncate")
    public Map<String, Object> truncateChat(
            @PathVariable String sessionId,
            @RequestBody Map<String, Integer> body
    ) {
        int remaining = session.truncateSession(sessionId, body.getOrDefault("index", 0));
        return Map.of("session_id", sessionId, "remaining", remaining);
    }

    @PostMapping("/chat/{sessionId}/stop")
    public Map<String, Boolean> stop(@PathVariable String sessionId) {
        cancellation.cancel(sessionId);
        return Map.of("ok", true);
    }

    @PostMapping("/tool-confirm/{requestId}")
    public Map<String, Object> confirmTool(
            @PathVariable String requestId,
            @RequestBody Map<String, Boolean> body
    ) {
        boolean approved = body.getOrDefault("approved", false);
        boolean resolved = confirmations.resolve(requestId, approved);
        return Map.of("ok", resolved);
    }
}
