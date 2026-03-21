package com.lifeos.core.agent;

import com.lifeos.config.AppConfig;
import com.lifeos.core.helpers.EventBus;
import com.lifeos.core.helpers.PromptParts;
import com.lifeos.core.managers.WebPushService;
import com.lifeos.core.managers.tools.AgentChannels;
import com.lifeos.core.executor.Confirmations;
import com.lifeos.core.agent.AgentRunLogs;

/**
 * A config-driven agent. Behaviour is fully defined by an AgentDefinition loaded from agent.yml —
 * no per-agent subclass needed. Instantiated and wired by AgentRegistry.
 */
public class ConfigAgent extends BaseAgent {

    private final AgentDefinition def;

    public ConfigAgent(AgentDefinition def,
                       ToolInvoker toolInvoker,
                       AgentChannels agentChannels,
                       EventBus eventBus,
                       Confirmations confirmations, 
                       AppConfig config, 
                       WebPushService webPush,
                       AgentRunLogs agentRunStore) {
        super(toolInvoker, agentChannels, eventBus, confirmations, config, webPush, agentRunStore);
        this.def = def;
    }

    public String getName() { return def.name(); }
    public String getTitle() { return def.title(); }
    public String getDescription() { return def.description(); }
    @Override
    protected String agentName() { return def.name(); }

    @Override
    protected String identity() {
        if (def.identity() == null || def.identity().isEmpty()) return "";
        return def.identity().stream()
                .map(f -> PromptParts.load(def.promptBase(), f))
                .collect(java.util.stream.Collectors.joining("\n\n"));
    }

    @Override
    protected boolean isModeEnabled(String mode) {
        return !def.disabledModes().contains(mode);
    }
}
