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
        String goal,                       // durable purpose statement; injected as # Your Goal in every system prompt
        String promptBase,
        String manager,                    // agent name of the manager who hired this agent; null = hired by client
        List<String> identity,             // used in all modes (chat, post-session, heartbeat, messaging)
        String chatPrompt,                 // file name loaded ONLY in chat mode; null = no per-agent chat additions
        ToolsFilter tools,                 // used in all modes; null = all tools
        Set<String> disabledModes,         // modes to skip; empty = all enabled
        List<RecurringTask> recurringTasks,    // platform-managed tasks created in tasks.json
        List<String> subscribedTopics,     // knowledge-board topics to read on heartbeat; from "subscribed-topics:"
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
     * A platform-managed recurring task created in tasks.json with the prompt file content
     * as the description. Agents pick it up during heartbeat via get_overdue_tasks.
     */
    public record RecurringTask(String name, String promptFile, double cadenceHours) {}

    /** Per-agent reasoning override. Mirrors AppConfig.Reasoning. */
    public record Reasoning(String effort, Integer maxTokens) {}

    @SuppressWarnings("unchecked")
    public static AgentDefinition parse(Map<String, Object> map, String promptBase) {
        var name              = (String) map.get("name");
        var title             = (String) map.getOrDefault("title", name);
        var description       = (String) map.getOrDefault("description", "");
        var goal              = (String) map.get("goal");
        var manager           = (String) map.get("manager");
        var identity          = (List<String>) map.getOrDefault("identity", List.of());
        var chatPrompt        = (String) map.get("chat-prompt");
        var toolsMap          = (Map<String, Object>) map.get("tools");
        var disabledList      = (List<String>) map.getOrDefault("disabled-modes", List.of());
        var rtRaw             = (List<Map<String, Object>>) map.getOrDefault("recurring-tasks", List.of());
        var recurringTasks    = rtRaw.stream()
                .map(m -> new RecurringTask(
                        (String) m.get("name"),
                        (String) m.get("prompt"),
                        ((Number) m.get("cadence-hours")).doubleValue()))
                .toList();
        var subscribedTopics  = (List<String>) map.getOrDefault("subscribed-topics", List.of());
        var model             = (String) map.get("model");
        var backgroundModel   = (String) map.get("background-model");
        var reasoningMap      = (Map<String, Object>) map.get("reasoning");
        return new AgentDefinition(name, title, description, goal, promptBase, manager, identity,
                chatPrompt, parseFilter(toolsMap), Set.copyOf(disabledList), recurringTasks,
                List.copyOf(subscribedTopics), model, backgroundModel, parseReasoning(reasoningMap));
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
