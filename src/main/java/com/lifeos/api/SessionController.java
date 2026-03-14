package com.lifeos.api;

import com.lifeos.core.SessionManager;
import com.lifeos.tools.Projects;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/api")
public class SessionController {

    private final SessionManager session;
    private final Projects projects;

    public SessionController(SessionManager session, Projects projects) {
        this.session = session;
        this.projects = projects;
    }

    @GetMapping("/sessions")
    public Map<String, Object> listSessions() {
        return Map.of("sessions", session.listSessions());
    }

    @PostMapping("/sessions")
    public Map<String, String> createSession() {
        return Map.of("session_id", session.createNew());
    }

    @PostMapping("/sessions/for-project")
    public Map<String, String> sessionForProject(@RequestBody Map<String, String> body) {
        var projectName = body.getOrDefault("project_name", "");
        return Map.of("session_id", session.getOrCreateForProject(projectName));
    }

    @GetMapping("/projects")
    public Map<String, Object> getProjects() {
        return projects.list();
    }
}
