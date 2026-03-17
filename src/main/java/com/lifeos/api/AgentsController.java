package com.lifeos.api;

import com.lifeos.core.agents.AgentRegistry;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/agents")
public class AgentsController {

    private final AgentRegistry agentRegistry;

    public AgentsController(AgentRegistry agentRegistry) {
        this.agentRegistry = agentRegistry;
    }

    @GetMapping
    public List<Map<String, String>> list() {
        return agentRegistry.all().stream()
                .map(a -> Map.of("name", a.getName(), "title", a.getTitle()))
                .toList();
    }
}
