package com.lifeos.agentfleet;

import com.lifeos.agent.Agent;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;

import java.util.Collection;
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

    public AgentFleet(AgentRegistry registry, EventBus eventBus, AgentRouter router) {
        this.registry = registry;
        this.eventBus = eventBus;
        this.router = router;
    }

    // ── Chat routing ───────────────────────────────────────────────────────────

    public Flux<ServerSentEvent<String>> handleMessage(String sessionId, String message, String agentName) {
        return router.handleMessage(sessionId, message, agentName);
    }

    // ── Agent enumeration ──────────────────────────────────────────────────────

    public Collection<Agent> all() {
        return registry.all();
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
}
