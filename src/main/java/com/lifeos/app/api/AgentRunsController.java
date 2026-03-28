package com.lifeos.app.api;

import com.lifeos.agent.AgentRunLogs;
import com.lifeos.agentfleet.tools.ScheduledTasks;
import org.springframework.web.bind.annotation.*;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/**
 * REST endpoint for per-agent run history.
 * GET /api/agents/{name}/runs?limit=20
 */
@RestController
@RequestMapping("/api/agents")
public class AgentRunsController {

    private final AgentRunLogs agentRunStore;

    public AgentRunsController(AgentRunLogs agentRunStore) {
        this.agentRunStore = agentRunStore;
    }

    @GetMapping("/{name}/runs")
    public List<Map<String, Object>> getRuns(
            @PathVariable String name,
            @RequestParam(defaultValue = "20") int limit) {
        return agentRunStore.getRecentRuns(name, Math.min(limit, 100));
    }

    @GetMapping("/{name}/tasks")
    public Map<String, Object> getTasks(@PathVariable String name) {
        return new ScheduledTasks(Path.of(System.getProperty("user.dir")).resolve(".user-data/tasks.json")).list(null);
    }
}
