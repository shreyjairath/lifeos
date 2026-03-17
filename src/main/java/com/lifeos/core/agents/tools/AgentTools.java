package com.lifeos.core.agents.tools;

import com.lifeos.core.agents.AgentRegistry;
import com.lifeos.core.helpers.EventBus;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Component;
import org.yaml.snakeyaml.Yaml;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Provides the create_agent tool — lets the assistant spawn new specialist agents at runtime.
 * New agents are written to .user-data/agents/{name}/ and hot-registered in AgentRegistry.
 */
@Component
public class AgentTools {

    private static final Path AGENTS_DIR = ToolsRegistry.AGENTS_DIR;

    private final AgentRegistry agentRegistry;
    private final EventBus eventBus;

    public AgentTools(@Lazy AgentRegistry agentRegistry, EventBus eventBus) {
        this.agentRegistry = agentRegistry;
        this.eventBus = eventBus;
    }

    public Map<String, Object> messageAgent(String fromAgent, String targetAgent, String message) {
        var agent = agentRegistry.get(targetAgent);
        if (agent == null)
            return Map.of("error", "Agent '" + targetAgent + "' not found. Use list_agents to see available agents.");
        try {
            var response = agent.message(fromAgent, message);
            return Map.of("agent", targetAgent, "response", response);
        } catch (Exception e) {
            return Map.of("error", "Failed to message agent '" + targetAgent + "': " + e.getMessage());
        }
    }

    public Map<String, Object> listAgents(String callerName) {
        return Map.of("agents", agentRegistry.all().stream()
                .map(a -> {
                    var entry = new LinkedHashMap<String, Object>();
                    entry.put("name", a.getName());
                    entry.put("title", a.getTitle());
                    entry.put("description", a.getDescription());
                    if (a.getName().equals(callerName)) entry.put("self", true);
                    return entry;
                })
                .toList());
    }

    public Map<String, Object> readAgentDefinition(String name) {
        var agentDir = AGENTS_DIR.resolve(name);
        if (!Files.isDirectory(agentDir))
            return Map.of("error", "Agent '" + name + "' is not a dynamic agent or does not exist.");
        try {
            var result = new LinkedHashMap<String, Object>();
            result.put("agent_yml", Files.readString(agentDir.resolve("agent.yml")));
            for (var file : new String[]{"who-you-are.md", "chat.md", "reflect.md", "heartbeat.md"}) {
                var path = agentDir.resolve(file);
                if (Files.exists(path)) result.put(file, Files.readString(path));
            }
            return result;
        } catch (IOException e) {
            return Map.of("error", "Failed to read agent '" + name + "': " + e.getMessage());
        }
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> updateAgent(String name, String title, String description, String whoYouAre,
                                           String chatInstructions, String reflectInstructions,
                                           String heartbeatInstructions, List<String> tools) {
        var agentDir = AGENTS_DIR.resolve(name);
        if (!Files.isDirectory(agentDir))
            return Map.of("error", "Agent '" + name + "' is not a dynamic agent or does not exist.");
        try {
            var currentYaml = new Yaml().<Map<String, Object>>load(Files.readString(agentDir.resolve("agent.yml")));

            var newTitle       = title != null       ? title       : (String) currentYaml.getOrDefault("title", name);
            var newDesc        = description != null ? description : (String) currentYaml.getOrDefault("description", "");
            var newWhoYouAre   = whoYouAre != null   ? whoYouAre   : readIfExists(agentDir.resolve("who-you-are.md"));
            var newChat        = chatInstructions != null   ? chatInstructions   : readIfExists(agentDir.resolve("chat.md"));
            var newReflect     = reflectInstructions != null ? reflectInstructions : readIfExists(agentDir.resolve("reflect.md"));
            var newHeartbeat   = heartbeatInstructions != null ? heartbeatInstructions : readIfExists(agentDir.resolve("heartbeat.md"));

            List<String> newTools;
            if (tools != null) {
                newTools = tools;
            } else {
                var chatToolsMap = (Map<String, Object>) currentYaml.get("chat-tools");
                newTools = chatToolsMap != null ? (List<String>) chatToolsMap.get("names") : List.of();
            }

            Files.writeString(agentDir.resolve("who-you-are.md"), newWhoYouAre != null ? newWhoYouAre : "");
            Files.writeString(agentDir.resolve("chat.md"), newChat != null ? newChat : "");
            if (newReflect != null && !newReflect.isBlank())
                Files.writeString(agentDir.resolve("reflect.md"), newReflect);
            if (newHeartbeat != null && !newHeartbeat.isBlank())
                Files.writeString(agentDir.resolve("heartbeat.md"), newHeartbeat);

            var yaml = buildAgentYaml(name, newTitle, newDesc, newReflect, newHeartbeat, newTools);
            Files.writeString(agentDir.resolve("agent.yml"), yaml);

            Map<String, Object> yamlMap = new Yaml().load(yaml);
            agentRegistry.register(yamlMap, agentDir.toString());

            eventBus.publish(Map.of("type", "agents_updated"));
            return Map.of("success", "Agent '" + name + "' updated and re-registered.");
        } catch (Exception e) {
            return Map.of("error", "Failed to update agent '" + name + "': " + e.getMessage());
        }
    }

    private static String readIfExists(Path path) throws IOException {
        return Files.exists(path) ? Files.readString(path) : null;
    }

    public Map<String, Object> createAgent(String name, String title, String description, String whoYouAre,
                                           String chatInstructions, String reflectInstructions,
                                           String heartbeatInstructions, List<String> tools) {
        if (name == null || !name.matches("[a-z][a-z0-9_]*")) {
            return Map.of("error", "Agent name must be lowercase alphanumeric + underscore, starting with a letter (e.g. 'pm_coach')");
        }

        var agentDir = AGENTS_DIR.resolve(name);
        var promptBase = agentDir.toString();

        try {
            Files.createDirectories(agentDir);

            Files.writeString(agentDir.resolve("who-you-are.md"), whoYouAre);
            Files.writeString(agentDir.resolve("chat.md"), chatInstructions);
            if (reflectInstructions != null && !reflectInstructions.isBlank()) {
                Files.writeString(agentDir.resolve("reflect.md"), reflectInstructions);
            }
            if (heartbeatInstructions != null && !heartbeatInstructions.isBlank()) {
                Files.writeString(agentDir.resolve("heartbeat.md"), heartbeatInstructions);
            }

            var yaml = buildAgentYaml(name, title, description, reflectInstructions, heartbeatInstructions, tools);
            Files.writeString(agentDir.resolve("agent.yml"), yaml);

            var yamlParser = new Yaml();
            Map<String, Object> yamlMap = yamlParser.load(yaml);
            agentRegistry.register(yamlMap, promptBase);

            eventBus.publish(Map.of("type", "agents_updated"));
            return Map.of("success", "Agent '" + name + "' created and registered. Switch to it with agent: \"" + name + "\"");
        } catch (Exception e) {
            return Map.of("error", "Failed to create agent '" + name + "': " + e.getMessage());
        }
    }

    private String buildAgentYaml(String name, String title, String description, String reflectInstructions,
                                   String heartbeatInstructions, List<String> tools) {
        // agent_bash is always available — workspace is provisioned by AgentRegistry
        var allTools = new ArrayList<>(tools);
        if (!allTools.contains("agent_bash")) allTools.add(0, "agent_bash");

        var sb = new StringBuilder();
        sb.append("name: ").append(name).append("\n");
        sb.append("title: ").append(title != null && !title.isBlank() ? title : name).append("\n");
        if (description != null && !description.isBlank())
            sb.append("description: ").append(description).append("\n");
        sb.append("persona:\n  - who-you-are.md\n  - chat.md\n");
        if (reflectInstructions != null && !reflectInstructions.isBlank()) {
            sb.append("reflect-prompt:\n  - reflect.md\n");
            sb.append("reflect-tools:\n  mode: include\n  names:\n");
            for (var tool : allTools) sb.append("    - ").append(tool).append("\n");
        }
        if (heartbeatInstructions != null && !heartbeatInstructions.isBlank()) {
            sb.append("heartbeat-prompt: heartbeat.md\n");
        }
        sb.append("chat-tools:\n  mode: include\n  names:\n");
        for (var tool : allTools) sb.append("    - ").append(tool).append("\n");
        return sb.toString();
    }
}
