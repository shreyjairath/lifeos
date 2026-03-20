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
        List<String> identity,             // used in all modes (chat, post-session, heartbeat, messaging)
        ToolsFilter tools                  // used in all modes; null = all tools
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
        var identity     = (List<String>) map.getOrDefault("identity", List.of());
        var toolsMap     = (Map<String, Object>) map.get("tools");
        return new AgentDefinition(name, title, description, promptBase, identity, parseFilter(toolsMap));
    }

    @SuppressWarnings("unchecked")
    private static ToolsFilter parseFilter(Map<String, Object> map) {
        if (map == null) return null;
        return new ToolsFilter(
                (String) map.get("mode"),
                (List<String>) map.getOrDefault("names", List.of()));
    }
}
