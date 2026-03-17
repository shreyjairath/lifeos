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
        List<String> persona,
        List<String> reflectPrompt,    // null/empty = no reflection
        String heartbeatPrompt,        // null = no heartbeat
        List<String> messagePrompt,    // null/empty = use default framing
        ToolsFilter chatTools,
        ToolsFilter reflectTools,
        ToolsFilter messageTools       // null = use reflect-tools
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
        var name           = (String) map.get("name");
        var title          = (String) map.getOrDefault("title", name);
        var description    = (String) map.getOrDefault("description", "");
        var persona         = (List<String>) map.getOrDefault("persona", List.of());
        var reflectPrompt   = (List<String>) map.getOrDefault("reflect-prompt", List.of());
        var heartbeatPrompt = (String) map.get("heartbeat-prompt");
        var messagePrompt   = (List<String>) map.getOrDefault("message-prompt", List.of());
        var chatToolsMap    = (Map<String, Object>) map.get("chat-tools");
        var reflectToolsMap = (Map<String, Object>) map.get("reflect-tools");
        var messageToolsMap = (Map<String, Object>) map.get("message-tools");
        return new AgentDefinition(name, title, description, promptBase, persona, reflectPrompt, heartbeatPrompt,
                messagePrompt, parseFilter(chatToolsMap), parseFilter(reflectToolsMap), parseFilter(messageToolsMap));
    }

    @SuppressWarnings("unchecked")
    private static ToolsFilter parseFilter(Map<String, Object> map) {
        if (map == null) return null;
        return new ToolsFilter(
                (String) map.get("mode"),
                (List<String>) map.getOrDefault("names", List.of()));
    }
}
