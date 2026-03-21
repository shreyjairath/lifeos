package com.lifeos.api;

import com.lifeos.api.dto.ChatRequest;
import com.lifeos.core.managers.AgentRegistry;
import com.lifeos.core.managers.ChatManager;
import com.lifeos.core.agent.SessionHandler;
import com.lifeos.core.executor.Confirmations;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Flux;

import java.util.Map;

@RestController
@RequestMapping("/api")
public class ChatController {

    private final ChatManager chatManager;
    private final AgentRegistry agentRegistry;
    private final Confirmations confirmations;

    public ChatController(ChatManager chatManager,
        AgentRegistry agentRegistry, 
        Confirmations confirmations
    ) {
        this.chatManager = chatManager;
        this.agentRegistry = agentRegistry;
        this.confirmations = confirmations;
    }

    @PostMapping(value = "/chat", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> chat(@RequestBody ChatRequest request) {
        return chatManager.handleMessage(request.sessionId(), request.message(), request.agent());
    }

    @GetMapping("/chat/{agentName}/{sessionId}")
    public Map<String, Object> getChatHistory(
        @PathVariable String agentName,
        @PathVariable String sessionId
    ) {
        return agentRegistry.get(agentName).getSessionHandler().getDisplayHistory(sessionId);
    }

    @DeleteMapping("/chat/{agentName}/{sessionId}")
    public Map<String, String> clearChat(
        @PathVariable String agentName,
        @PathVariable String sessionId
    ) {
        agentRegistry.get(agentName).getSessionHandler().clearSession(sessionId);
        return Map.of("cleared", sessionId);
    }

    @PostMapping("/chat/{agentName}/{sessionId}/truncate")
    public Map<String, Object> truncateChat(
        @PathVariable String agentName,
        @PathVariable String sessionId,
        @RequestBody Map<String, Integer> body
    ) {
        int remaining = agentRegistry.get(agentName).getSessionHandler().truncateSession(sessionId, body.getOrDefault("index", 0));
        return Map.of("session_id", sessionId, "remaining", remaining);
    }

    @PostMapping("/chat/{agentName}/{sessionId}/stop")
    public Map<String, Boolean> stop(
        @PathVariable String agentName,
        @PathVariable String sessionId
    ) {
        agentRegistry.get(agentName).cancel(sessionId);
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
