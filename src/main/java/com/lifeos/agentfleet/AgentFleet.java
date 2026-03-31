package com.lifeos.agentfleet;

import com.lifeos.agent.Agent;
import com.lifeos.agent.PromptParts;
import com.lifeos.agentfleet.tools.ScheduledTasks;
import com.lifeos.config.AppConfig;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;

import java.nio.file.Path;
import java.time.Instant;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Public surface of the platform layer for the app layer.
 * Exposes chat routing, agent enumeration, session management, and event triggering
 * without leaking AgentRegistry, AgentRouter, SessionHandler, or EventBus to app.
 */
@Component
public class AgentFleet {

    private final AgentRegistry registry;
    private final EventBus eventBus;
    private final AgentRouter router;
    private final AppConfig config;

    public AgentFleet(AgentRegistry registry, EventBus eventBus, AgentRouter router, AppConfig config) {
        this.registry = registry;
        this.eventBus = eventBus;
        this.router = router;
        this.config = config;
    }

    // ── Chat routing ───────────────────────────────────────────────────────────

    public Flux<ServerSentEvent<String>> handleMessage(String sessionId, String message, String agentName, String model) {
        return router.handleMessage(sessionId, message, agentName, model);
    }

    // ── Agent enumeration ──────────────────────────────────────────────────────

    public Collection<Agent> all() {
        return registry.all();
    }

    /** Full structural definition for a single agent — no resolved prompt text. */
    public Map<String, Object> agentInfo(Agent a) {
        var def   = a.getDefinition();
        var tools = def.tools();
        var m = new LinkedHashMap<String, Object>();
        m.put("name",            def.name());
        m.put("title",           def.title());
        m.put("description",     def.description());
        m.put("model",           def.model());
        m.put("effectiveModel",  def.model() != null ? def.model() : config.model());
        m.put("backgroundModel", def.backgroundModel());
        m.put("reasoning",       def.reasoning() != null
                ? Map.of("effort", def.reasoning().effort(), "maxTokens", def.reasoning().maxTokens())
                : null);
        m.put("tools",           tools != null
                ? Map.of("mode", tools.mode(), "names", tools.names())
                : null);
        m.put("disabledModes",   def.disabledModes());
        return m;
    }

    /** Resolved identity text for GET /api/agents/{name}/definition. */
    public Map<String, Object> agentDefinitionText(String name) {
        var a   = registry.get(name);
        var def = a.getDefinition();

        var identityText = def.identity() == null ? "" : def.identity().stream()
                .map(f -> PromptParts.load(def.promptBase(), f))
                .collect(java.util.stream.Collectors.joining("\n\n"));

        return Map.of("identityText", identityText);
    }

    // ── Session management ─────────────────────────────────────────────────────

    public Map<String, Object> getHistory(String agentName, String sessionId) {
        return registry.get(agentName).getSessionHandler().getDisplayHistory(sessionId);
    }

    public void clearSession(String agentName, String sessionId) {
        registry.get(agentName).getSessionHandler().clearSession(sessionId);
    }

    public int truncateSession(String agentName, String sessionId, int fromIndex) {
        return registry.get(agentName).getSessionHandler().truncateSession(sessionId, fromIndex);
    }

    public List<Map<String, Object>> listAllSessions() {
        return registry.all().stream()
                .flatMap(a -> a.getSessionHandler().listSessions().stream())
                .toList();
    }

    public List<Map<String, Object>> listSessions(String agentName) {
        return registry.get(agentName).getSessionHandler().listSessions();
    }

    public String createSession(String agentName) {
        return registry.get(agentName).getSessionHandler().createNew(agentName);
    }

    public void deleteSession(String agentName, String sessionId) {
        registry.get(agentName).getSessionHandler().delete(sessionId);
    }

    public void pruneSessions(String agentName) {
        registry.get(agentName).getSessionHandler().pruneEmptySessions();
    }

    public void checkExpiredSessions() {
        registry.all().forEach(a -> a.getSessionHandler().checkExpiredSessions());
    }

    // ── Run control ────────────────────────────────────────────────────────────

    public void cancel(String agentName, String sessionId) {
        registry.get(agentName).cancel(sessionId);
    }

    // ── Event triggers ─────────────────────────────────────────────────────────

    public void trigger(String eventType, Map<String, Object> extra) {
        var event = new java.util.HashMap<String, Object>();
        if (extra != null) event.putAll(extra);
        event.put("type", eventType);
        eventBus.publish(event);
    }

    // ── Background task board ───────────────────────────────────────────────────

    /**
     * Called on startup — upserts recurring tasks (self_eval, self_learning) in tasks.json.
     * Agents pick these up during heartbeat via get_overdue_tasks.
     */
    public void initBackgroundTasks() {
        var tasks = scheduledTasks();
        for (var agent : registry.all()) {
            var def = agent.getDefinition();
            for (var rt : def.recurringTasks()) {
                var description = com.lifeos.agent.PromptParts.load(def.promptBase(), rt.promptFile());
                tasks.upsert("platform",
                        def.name() + "." + rt.name(),
                        description,
                        rt.cadenceHours(),
                        Instant.now().toString(),
                        def.name());
            }
        }
    }

    /** Fires heartbeat_trigger for every agent (unless they have it in disabled-modes). */
    public void triggerHeartbeat() {
        for (var agent : registry.all()) {
            var def = agent.getDefinition();
            if (!def.disabledModes().contains("heartbeat_trigger")) {
                trigger("heartbeat_trigger", Map.of("agent", def.name()));
            }
        }
    }

    private static ScheduledTasks scheduledTasks() {
        return new ScheduledTasks(Path.of(System.getProperty("user.dir")).resolve(".user-data/tasks.json"));
    }
}
