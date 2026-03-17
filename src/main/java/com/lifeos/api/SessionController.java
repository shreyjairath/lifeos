package com.lifeos.api;

import com.lifeos.core.managers.SessionManager;
import org.springframework.web.bind.annotation.*;

import java.util.*;

@RestController
@RequestMapping("/api")
public class SessionController {

    private final SessionManager session;

    public SessionController(SessionManager session) { this.session = session; }

    @GetMapping("/sessions")
    public Map<String, Object> listSessions() {
        return Map.of("sessions", session.listSessions());
    }

    @PostMapping("/sessions")
    public Map<String, String> createSession(@RequestBody(required = false) Map<String, String> body) {
        var agent = body != null ? body.get("agent") : null;
        return Map.of("session_id", session.createNew(agent));
    }
}
