package com.lifeos.app.api;


import com.lifeos.agentfleet.AgentFleet;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/agents")
public class AgentsController {

    private final AgentFleet agentFleet;

    public AgentsController(AgentFleet agentFleet) { this.agentFleet = agentFleet; }

    @GetMapping
    public List<Map<String, String>> list() {
        return agentFleet.all().stream()
                .map(a -> Map.of("name", a.getName(), "title", a.getTitle()))
                .toList();
    }

    @PostMapping("/trigger/{eventType}")
    public Map<String, String> trigger(@PathVariable String eventType,
                                       @RequestBody(required = false) Map<String, Object> extra) {
        agentFleet.trigger(eventType, extra);
        return Map.of("triggered", eventType);
    }

    private static final Path CHANNELS_DIR = Path.of(".user-data/agents/inter-agent-channels");

    @GetMapping("/channels")
    public List<Map<String, Object>> listChannels() {
        if (!Files.isDirectory(CHANNELS_DIR)) return List.of();
        try (var stream = Files.list(CHANNELS_DIR)) {
            return stream
                    .filter(p -> p.getFileName().toString().endsWith(".md"))
                    .map(p -> {
                        var name = p.getFileName().toString().replace(".md", "");
                        var agents = List.of(name.split("-", 2));
                        return (Map<String, Object>) Map.of("pair", name, "agents", agents);
                    })
                    .sorted(java.util.Comparator.comparing(m -> (String) m.get("pair")))
                    .toList();
        } catch (IOException e) {
            return List.of();
        }
    }

    @GetMapping("/channels/{pair}")
    public ResponseEntity<Map<String, String>> getChannel(@PathVariable String pair) {
        var file = CHANNELS_DIR.resolve(pair + ".md");
        if (!Files.exists(file)) return ResponseEntity.notFound().build();
        try {
            return ResponseEntity.ok(Map.of("pair", pair, "content", Files.readString(file)));
        } catch (IOException e) {
            return ResponseEntity.internalServerError().build();
        }
    }
}
