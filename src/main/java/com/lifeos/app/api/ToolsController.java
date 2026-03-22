package com.lifeos.app.api;

import com.lifeos.agentfleet.ToolsRegistry;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.util.*;

@RestController
@RequestMapping("/api/tools")
public class ToolsController {

    private final ToolsRegistry toolsRegistry;

    public ToolsController(ToolsRegistry toolsRegistry) {
        this.toolsRegistry = toolsRegistry;
    }

    @GetMapping
    public Map<String, Object> getTools() {
        var disabled = ToolsRegistry.loadDisabledTools();
        return Map.of("tools", toolsRegistry.allToolNames(), "disabled", disabled);
    }

    @PutMapping("/disabled")
    public Map<String, Object> setDisabled(@RequestBody Map<String, List<String>> body) {
        var names = new LinkedHashSet<>(body.getOrDefault("disabled", List.of()));
        try {
            ToolsRegistry.saveDisabledTools(names);
            return Map.of("disabled", names);
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, e.getMessage());
        }
    }
}
