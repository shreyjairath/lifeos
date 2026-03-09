package com.lifeos.api;

import com.lifeos.core.Memory;
import com.lifeos.tools.Projects;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/api")
public class ConversationController {

    private final Memory memory;
    private final Projects projects;

    public ConversationController(Memory memory, Projects projects) {
        this.memory = memory;
        this.projects = projects;
    }

    @GetMapping("/conversations")
    public Map<String, Object> listConversations() {
        return Map.of("conversations", memory.listConversations());
    }

    @PostMapping("/conversations/for-project")
    public Map<String, String> conversationForProject(@RequestBody Map<String, String> body) {
        var projectName = body.getOrDefault("project_name", "");
        var cs = memory.getOrCreateForProject(projectName);
        return Map.of("conv_id", cs.convId(), "session_id", cs.sessionId());
    }

    @GetMapping("/conversations/main")
    public Map<String, String> getMainConversation() {
        var cs = memory.getOrCreateMain();
        return Map.of("conv_id", cs.convId(), "session_id", cs.sessionId());
    }

    @GetMapping("/projects")
    public Map<String, Object> getProjects() {
        return projects.list();
    }
}
