package com.lifeos.agent;

import java.util.List;
import java.util.Map;
import java.util.Set;

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
        ToolsFilter tools,                 // used in all modes; null = all tools
        Set<String> disabledModes,         // modes to skip; empty = all enabled
        List<BackgroundMode> backgroundModes,  // event-triggered bg runs; empty = none
        String model,                      // overrides global model for chat runs; null = use global
        String backgroundModel,            // overrides global background-model; null = use global
        Reasoning reasoning                // overrides global reasoning config; null = use global
) {
    /**
     * Defines which tools are available.
     *   mode=include — only the named tools
     *   mode=exclude — all tools except the named ones
     *   null — all tools
     */
    public record ToolsFilter(String mode, List<String> names) {}

    /**
     * Maps an event bus trigger (e.g. "heartbeat_trigger") to a run mode name and prompt file.
     * The trigger value must match the {@code type} of a {@code scheduled-triggers} entry in application.yml.
     */
    public record BackgroundMode(String trigger, String promptFile) {}

    /** Per-agent reasoning override. Mirrors AppConfig.Reasoning. */
    public record Reasoning(String effort, Integer maxTokens) {}

    @SuppressWarnings("unchecked")
    public static AgentDefinition parse(Map<String, Object> map, String promptBase) {
        var name              = (String) map.get("name");
        var title             = (String) map.getOrDefault("title", name);
        var description       = (String) map.getOrDefault("description", "");
        var identity          = (List<String>) map.getOrDefault("identity", List.of());
        var toolsMap          = (Map<String, Object>) map.get("tools");
        var disabledList      = (List<String>) map.getOrDefault("disabled-modes", List.of());
        var bgRaw             = (List<Map<String, Object>>) map.getOrDefault("background-modes", List.of());
        var backgroundModes   = bgRaw.stream()
                .map(m -> new BackgroundMode((String) m.get("trigger"), (String) m.get("prompt")))
                .toList();
        var model             = (String) map.get("model");
        var backgroundModel   = (String) map.get("background-model");
        var reasoningMap      = (Map<String, Object>) map.get("reasoning");
        return new AgentDefinition(name, title, description, promptBase, identity,
                parseFilter(toolsMap), Set.copyOf(disabledList), backgroundModes,
                model, backgroundModel, parseReasoning(reasoningMap));
    }

    private static Reasoning parseReasoning(Map<String, Object> map) {
        if (map == null) return null;
        var effort    = (String) map.get("effort");
        var maxTokens = map.get("max-tokens") instanceof Number n ? n.intValue() : null;
        return new Reasoning(effort, maxTokens);
    }

    @SuppressWarnings("unchecked")
    private static ToolsFilter parseFilter(Map<String, Object> map) {
        if (map == null) return null;
        return new ToolsFilter(
                (String) map.get("mode"),
                (List<String>) map.getOrDefault("names", List.of()));
    }
}
