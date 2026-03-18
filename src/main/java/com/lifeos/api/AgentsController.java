package com.lifeos.api;

import com.lifeos.core.agents.AgentRegistry;
import com.lifeos.core.helpers.EventBus;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/agents")
public class AgentsController {

    private final AgentRegistry agentRegistry;
    private final EventBus eventBus;

    public AgentsController(AgentRegistry agentRegistry, EventBus eventBus) {
        this.agentRegistry = agentRegistry;
        this.eventBus = eventBus;
    }

    @GetMapping
    public List<Map<String, String>> list() {
        return agentRegistry.all().stream()
                .map(a -> Map.of("name", a.getName(), "title", a.getTitle()))
                .toList();
    }

    @PostMapping("/trigger/{eventType}")
    public Map<String, String> trigger(@PathVariable String eventType,
                                       @RequestBody(required = false) Map<String, Object> extra) {
        var event = new java.util.HashMap<String, Object>();
        if (extra != null) event.putAll(extra);
        event.put("type", eventType);
        eventBus.publish(event);
        return Map.of("triggered", eventType);
    }
}
