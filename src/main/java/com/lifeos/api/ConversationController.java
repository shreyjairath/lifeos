package com.lifeos.api;

import com.lifeos.core.Session;
import com.lifeos.tools.Projects;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/api")
public class ConversationController {

    private final Session session;
    private final Projects projects;

    public ConversationController(Session session, Projects projects) {
        this.session = session;
        this.projects = projects;
    }

    @GetMapping("/conversations")
    public Map<String, Object> listConversations() {
        return Map.of("conversations", session.listConversations());
    }

    @PostMapping("/conversations/for-project")
    public Map<String, String> conversationForProject(@RequestBody Map<String, String> body) {
        var projectName = body.getOrDefault("project_name", "");
        var cs = session.getOrCreateForProject(projectName);
        return Map.of("conv_id", cs.convId(), "session_id", cs.sessionId());
    }

    @GetMapping("/conversations/main")
    public Map<String, String> getMainConversation() {
        var cs = session.getOrCreateMain();
        return Map.of("conv_id", cs.convId(), "session_id", cs.sessionId());
    }

    @GetMapping("/projects")
    public Map<String, Object> getProjects() {
        return projects.list();
    }
}
