package com.lifeos.app.api;

import com.lifeos.app.api.dto.ChatRequest;
import com.lifeos.agentfleet.AgentFleet;
import com.lifeos.agent.executor.Confirmations;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Flux;

import java.util.Map;

@RestController
@RequestMapping("/api")
public class ChatController {

    private final AgentFleet agentFleet;
    private final Confirmations confirmations;

    public ChatController(AgentFleet agentFleet, Confirmations confirmations) {
        this.agentFleet = agentFleet;
        this.confirmations = confirmations;
    }

    @PostMapping(value = "/chat", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> chat(@RequestBody ChatRequest request) {
        return agentFleet.handleMessage(request.sessionId(), request.message(), request.agent());
    }

    @GetMapping("/chat/{agentName}/{sessionId}")
    public Map<String, Object> getChatHistory(@PathVariable String agentName, @PathVariable String sessionId) {
        return agentFleet.getHistory(agentName, sessionId);
    }

    @DeleteMapping("/chat/{agentName}/{sessionId}")
    public Map<String, String> clearChat(@PathVariable String agentName, @PathVariable String sessionId) {
        agentFleet.clearSession(agentName, sessionId);
        return Map.of("cleared", sessionId);
    }

    @PostMapping("/chat/{agentName}/{sessionId}/truncate")
    public Map<String, Object> truncateChat(@PathVariable String agentName, @PathVariable String sessionId,
                                             @RequestBody Map<String, Integer> body) {
        int remaining = agentFleet.truncateSession(agentName, sessionId, body.getOrDefault("index", 0));
        return Map.of("session_id", sessionId, "remaining", remaining);
    }

    @PostMapping("/chat/{agentName}/{sessionId}/stop")
    public Map<String, Boolean> stop(@PathVariable String agentName, @PathVariable String sessionId) {
        agentFleet.cancel(agentName, sessionId);
        return Map.of("ok", true);
    }

    @PostMapping("/tool-confirm/{requestId}")
    public Map<String, Object> confirmTool(@PathVariable String requestId,
                                            @RequestBody Map<String, Boolean> body) {
        boolean approved = body.getOrDefault("approved", false);
        boolean resolved = confirmations.resolve(requestId, approved);
        return Map.of("ok", resolved);
    }
}
