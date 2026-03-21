package com.lifeos.api;

import com.lifeos.core.managers.AgentRegistry;

import org.springframework.web.bind.annotation.*;

import java.util.*;

@RestController
@RequestMapping("/api")
public class SessionController {

    private final AgentRegistry agentRegistry;

    public SessionController(AgentRegistry agentRegistry) { this.agentRegistry = agentRegistry; }

    @GetMapping("/sessions")
    public Map<String, Object> listSessions() {
        // List allSessions = new ArrayList<>();
        // agentRegistry.all().iterator().forEachRemaining(
        //     a -> allSessions.addAll(a.getSessionHandler().listSessions())
        // );
        return Map.of("sessions", agentRegistry.get("cos").getSessionHandler().listSessions());
    }

    @GetMapping("/sessions/{agentName}")
    public Map<String, Object> listSessions(@PathVariable String agentName) {
        return Map.of("sessions", agentRegistry.get(agentName).getSessionHandler().listSessions());
    }

    @PostMapping("/sessions")
    public Map<String, String> createSession(@RequestBody(required = false) Map<String, String> body) {
        var agentName = body != null ? body.get("agent") : null;
        return Map.of("session_id", agentRegistry.get(agentName).getSessionHandler().createNew(agentName));
    }

    @DeleteMapping("/sessions/{agentName}/{sessionId}")
    public Map<String, String> deleteSession(@PathVariable String agentName, @PathVariable String sessionId) {
        agentRegistry.get(agentName).getSessionHandler().delete(sessionId);
        return Map.of("deleted", sessionId);
    }

    @PostMapping("/sessions/prune")
    public Map<String, String> pruneSessions(@RequestBody(required = false) Map<String, String> body) {
        var agentName = body != null ? body.get("agent") : null;
        agentRegistry.get(agentName).getSessionHandler().pruneEmptySessions();
        return Map.of("status", "ok");
    }
}
