package com.lifeos.core.agents;

import com.lifeos.config.AppConfig;
import com.lifeos.core.helpers.EventBus;
import com.lifeos.core.helpers.PromptParts;
import com.lifeos.core.managers.SessionManager;
import com.lifeos.core.managers.WebPushService;
import com.lifeos.core.agents.executor.BaseAgent;
import com.lifeos.core.agents.executor.Cancellation;
import com.lifeos.core.agents.executor.Executor;
import com.lifeos.core.agents.tools.ToolsRegistry;

import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * A config-driven agent. Behaviour is fully defined by an AgentDefinition loaded from agent.yml —
 * no per-agent subclass needed. Instantiated and wired by AgentRegistry.
 */
public class Agent extends BaseAgent {

    private final AgentDefinition def;

    public Agent(AgentDefinition def,
                 Executor executor, ToolsRegistry toolsRegistry,
                 SessionManager session, EventBus eventBus,
                 Cancellation cancellation, AppConfig config, WebPushService webPush) {
        super(executor, toolsRegistry, session, eventBus, cancellation, config, webPush);
        this.def = def;
    }

    public String getName() { return def.name(); }
    public String getTitle() { return def.title(); }
    public String getDescription() { return def.description(); }
    @Override
    protected String agentName() { return def.name(); }

    @Override
    protected String persona() {
        return def.persona().stream()
                .map(f -> PromptParts.load(def.promptBase(), f))
                .collect(java.util.stream.Collectors.joining("\n\n"));
    }

    @Override
    protected List<Map<String, Object>> tools() {
        return applyFilter(def.chatTools());
    }

    @Override
    protected String reflectPrompt() {
        if (def.reflectPrompt() == null || def.reflectPrompt().isEmpty()) return null;
        return def.reflectPrompt().stream()
                .map(f -> PromptParts.load(def.promptBase(), f))
                .collect(java.util.stream.Collectors.joining("\n\n"));
    }

    @Override
    protected List<Map<String, Object>> reflectTools() {
        return applyFilter(def.reflectTools());
    }

    @Override
    protected String heartbeatPrompt() {
        if (def.heartbeatPrompt() == null) return null;
        return PromptParts.load(def.promptBase(), def.heartbeatPrompt());
    }

    @Override
    protected String messagePrompt() {
        if (def.messagePrompt() == null || def.messagePrompt().isEmpty()) return null;
        return def.messagePrompt().stream()
                .map(f -> PromptParts.load(def.promptBase(), f))
                .collect(java.util.stream.Collectors.joining("\n\n"));
    }

    @Override
    protected List<Map<String, Object>> messageTools() {
        if (def.messageTools() == null) return reflectTools();
        return applyFilter(def.messageTools());
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private List<Map<String, Object>> applyFilter(AgentDefinition.ToolsFilter filter) {
        if (filter == null) return toolsRegistry.getTools();
        var names = Set.copyOf(filter.names());
        return toolsRegistry.getTools().stream()
                .filter(t -> names.contains(t.get("name")))
                .toList();
    }
}
