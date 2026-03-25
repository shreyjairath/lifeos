package com.lifeos.app.api;

import com.lifeos.agentfleet.AgentFleet;
import org.springframework.web.bind.annotation.*;

import java.util.*;

@RestController
@RequestMapping("/api")
public class SessionController {

    private final AgentFleet agentFleet;

    public SessionController(AgentFleet agentFleet) { this.agentFleet = agentFleet; }

    @GetMapping("/sessions")
    public Map<String, Object> listSessions() {
        return Map.of("sessions", agentFleet.listAllSessions());
    }

    @GetMapping("/sessions/{agentName}")
    public Map<String, Object> listSessions(@PathVariable String agentName) {
        return Map.of("sessions", agentFleet.listSessions(agentName));
    }

    @PostMapping("/sessions")
    public Map<String, String> createSession(@RequestBody(required = false) Map<String, String> body) {
        var agentName = body != null ? body.get("agent") : null;
        return Map.of("session_id", agentFleet.createSession(agentName));
    }

    @DeleteMapping("/sessions/{agentName}/{sessionId}")
    public Map<String, String> deleteSession(@PathVariable String agentName, @PathVariable String sessionId) {
        agentFleet.deleteSession(agentName, sessionId);
        return Map.of("deleted", sessionId);
    }

    @PostMapping("/sessions/prune")
    public Map<String, String> pruneSessions(@RequestBody(required = false) Map<String, String> body) {
        var agentName = body != null ? body.get("agent") : null;
        agentFleet.pruneSessions(agentName);
        return Map.of("status", "ok");
    }
}
