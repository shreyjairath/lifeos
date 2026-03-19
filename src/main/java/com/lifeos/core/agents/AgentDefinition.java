package com.lifeos.core.agents;

import java.util.List;
import java.util.Map;

/**
 * Parsed representation of an agent.yml config file.
 * Loaded by AgentRegistry at startup — no per-agent Java class needed.
 */
public record AgentDefinition(
        String name,
        String title,
        String description,
        String promptBase,
        List<String> identity,             // used in all modes (post-session, heartbeat, messaging, chat)
        List<String> chatPrompt,           // used only in user-facing chat system prompt
        List<String> postSessionPrompt,    // null/empty = no post-session update
        String selfEvalPrompt,             // null = no self-evaluation
        String heartbeatPrompt,            // null = no heartbeat
        ToolsFilter chatTools,
        ToolsFilter postSessionTools,
        ToolsFilter messageTools           // null = use postSessionTools
) {
    /**
     * Defines which tools are available in a given mode.
     *   mode=include — only the named tools
     *   mode=exclude — all tools except the named ones
     *   null — all tools
     */
    public record ToolsFilter(String mode, List<String> names) {}

    @SuppressWarnings("unchecked")
    public static AgentDefinition parse(Map<String, Object> map, String promptBase) {
        var name              = (String) map.get("name");
        var title             = (String) map.getOrDefault("title", name);
        var description       = (String) map.getOrDefault("description", "");
        var identity          = (List<String>) map.getOrDefault("identity", List.of());
        var chatPrompt        = (List<String>) map.getOrDefault("chat-prompt", List.of());
        var postSessionPrompt = (List<String>) map.getOrDefault("post-session-prompt", List.of());
        var selfEvalPrompt    = (String) map.get("self-eval-prompt");
        var heartbeatPrompt   = (String) map.get("heartbeat-prompt");
        var chatToolsMap         = (Map<String, Object>) map.get("chat-tools");
        var postSessionToolsMap  = (Map<String, Object>) map.get("post-session-tools");
        var messageToolsMap      = (Map<String, Object>) map.get("message-tools");
        return new AgentDefinition(name, title, description, promptBase, identity, chatPrompt,
                postSessionPrompt, selfEvalPrompt, heartbeatPrompt,
                parseFilter(chatToolsMap), parseFilter(postSessionToolsMap), parseFilter(messageToolsMap));
    }

    @SuppressWarnings("unchecked")
    private static ToolsFilter parseFilter(Map<String, Object> map) {
        if (map == null) return null;
        return new ToolsFilter(
                (String) map.get("mode"),
                (List<String>) map.getOrDefault("names", List.of()));
    }
}
