package com.lifeos.api;

import com.lifeos.api.dto.ChatRequest;
import com.lifeos.core.ConversationManager;
import com.lifeos.core.Memory;
import com.lifeos.executor.Cancellation;
import com.lifeos.executor.Confirmations;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Flux;

import java.util.Map;

@RestController
@RequestMapping("/api")
public class ChatController {

    private final ConversationManager conversationManager;
    private final Memory memory;
    private final Cancellation cancellation;
    private final Confirmations confirmations;

    public ChatController(ConversationManager conversationManager, Memory memory,
                          Cancellation cancellation, Confirmations confirmations) {
        this.conversationManager = conversationManager;
        this.memory = memory;
        this.cancellation = cancellation;
        this.confirmations = confirmations;
    }

    @PostMapping(value = "/chat", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> chat(@RequestBody ChatRequest request) {
        return conversationManager.handleMessage(
                request.convId(), request.sessionId(), request.message());
    }

    @GetMapping("/chat/{convId}")
    public Map<String, Object> getAllChatHistory(@PathVariable String convId) {
        return memory.getAllDisplayHistory(convId);
    }

    @GetMapping("/chat/{convId}/{sessionId}")
    public Map<String, Object> getChatHistory(@PathVariable String convId, @PathVariable String sessionId) {
        var result = memory.getDisplayHistory(convId, sessionId);
        return Map.of("conv_id", convId, "session_id", sessionId,
                "messages", result.get("messages"), "total", result.get("total"));
    }

    @DeleteMapping("/chat/{convId}/{sessionId}")
    public Map<String, String> clearChat(@PathVariable String convId, @PathVariable String sessionId) {
        memory.clearSession(convId, sessionId);
        return Map.of("cleared", sessionId);
    }

    @PostMapping("/chat/{convId}/{sessionId}/truncate")
    public Map<String, Object> truncateChat(
            @PathVariable String convId, @PathVariable String sessionId,
            @RequestBody Map<String, Integer> body
    ) {
        int remaining = memory.truncateSession(convId, sessionId, body.getOrDefault("index", 0));
        return Map.of("session_id", sessionId, "remaining", remaining);
    }

    @PostMapping("/chat/{convId}/{sessionId}/stop")
    public Map<String, Boolean> stop(@PathVariable String convId, @PathVariable String sessionId) {
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
