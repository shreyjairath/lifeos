package com.lifeos.agentfleet;

import com.lifeos.config.AppConfig;
import com.lifeos.agentfleet.EventBus;
import com.lifeos.agent.executor.Confirmations;
import com.lifeos.agent.AgentRunLogs;
import com.lifeos.agentfleet.ToolsRegistry;
import com.lifeos.agent.AgentDefinition;
import com.lifeos.agent.Agent;
import com.lifeos.agent.BaseAgent;
import com.lifeos.agent.session.SessionHandler;
import com.lifeos.agent.ToolInvoker;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.stereotype.Component;
import org.yaml.snakeyaml.Yaml;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Loads agent definitions from classpath: agents/{name}/agent.yml, creates ConfigAgent instances,
 * and wires their event listeners. Agents are keyed by name (e.g. "cos", "therapist").
 *
 * To add a new agent: drop an agent.yml in src/main/resources/agents/{name}/. No Java class needed.
 */
@Component
public class AgentRegistry {

    private static final Logger log = LoggerFactory.getLogger(AgentRegistry.class);

    private final Map<String, Agent> agents = new LinkedHashMap<>();

    private final ToolsRegistry toolsRegistry;
    private final EventBus eventBus;
    private final Confirmations confirmations;
    private final AppConfig config;
    private final AgentRunLogs agentRunStore;

    public AgentRegistry(ToolsRegistry toolsRegistry,
                         EventBus eventBus,
                         Confirmations confirmations,
                         AppConfig config,
                         AgentRunLogs agentRunStore) {
        this.toolsRegistry = toolsRegistry;
        this.eventBus = eventBus;
        this.confirmations = confirmations;
        this.config = config;
        this.agentRunStore = agentRunStore;
    }

    private static final Path USER_AGENTS_DIR = ToolsRegistry.AGENTS_DIR;

    @PostConstruct
    public void load() throws Exception {
        var yaml = new Yaml();

        // Load built-in agents from classpath
        var resolver = new PathMatchingResourcePatternResolver();
        var resources = resolver.getResources("classpath*:agents/*/agent.yml");
        for (var resource : resources) {
            try {
                var path = resource.getURI().toString();
                var promptBase = path.substring(path.indexOf("agents/"), path.lastIndexOf("/"));
                Map<String, Object> map = yaml.load(resource.getInputStream());
                loadAgent(map, promptBase);
            } catch (Exception e) {
                log.warn("AgentRegistry: failed to load {}: {}", resource, e.getMessage());
            }
        }

        // Load dynamic agents from .user-data/agents/*/agent.yml
        if (Files.isDirectory(USER_AGENTS_DIR)) {
            try (var dirs = Files.list(USER_AGENTS_DIR)) {
                dirs.filter(Files::isDirectory).forEach(dir -> {
                    var agentYml = dir.resolve("agent.yml");
                    if (!Files.exists(agentYml)) return;
                    try {
                        Map<String, Object> map = yaml.load(Files.readString(agentYml));
                        loadAgent(map, dir.toString());
                    } catch (Exception e) {
                        log.warn("AgentRegistry: failed to load {}: {}", agentYml, e.getMessage());
                    }
                });
            }
        }

        if (agents.isEmpty()) {
            log.warn("AgentRegistry: no agents loaded — check agents/*/agent.yml on classpath");
        }
    }

    /** Hot-registers a dynamic agent from a parsed YAML map. Called by AgentTools.createAgent(). */
    public Agent register(Map<String, Object> yamlMap, String promptBase) throws IOException {
        return loadAgent(yamlMap, promptBase);
    }

    private Agent loadAgent(Map<String, Object> map, String promptBase) {
        var def = AgentDefinition.parse(map, promptBase);
        try {
            var workspace = USER_AGENTS_DIR.resolve(def.name()).resolve("workspace");
            Files.createDirectories(workspace);
            toolsRegistry.registerAgentWorkspace(def.name(), workspace);
        } catch (IOException e) {
            log.warn("AgentRegistry: failed to provision workspace for '{}': {}", def.name(), e.getMessage());
        }
        var filter = def.tools();
        var nameSet = filter == null ? Set.<String>of() : Set.copyOf(filter.names());
        var defs = filter == null ? toolsRegistry.getTools()
                : "exclude".equals(filter.mode())
                    ? toolsRegistry.getTools().stream()
                        .filter(t -> !nameSet.contains(t.get("name")))
                        .toList()
                    : toolsRegistry.getTools().stream()
                        .filter(t -> nameSet.contains(t.get("name")))
                        .toList();
        ToolInvoker invoker = new ToolInvoker() {
            public List<Map<String, Object>> definitions() { return defs; }
            public Map<String, Object> invoke(String name, Map<String, Object> input, String agent) {
                return toolsRegistry.dispatch(name, input, agent);
            }
        };
        var agent = new BaseAgent(def, invoker, toolsRegistry.agentChannels(),
                eventBus, confirmations, config, agentRunStore,
                () -> agents.values().stream()
                        .filter(a -> def.name().equals(a.getDefinition().manager()))
                        .map(Agent::getName)
                        .toList());
        agents.put(def.name(), agent);
        log.info("AgentRegistry: loaded agent '{}' from {}", def.name(), promptBase);
        return agent;
    }

    /** Returns the agent with the given name, or the first agent if name is unknown. */
    public Agent get(String name) {
        var a = agents.get(name);
        if (a != null) return a;
        return agents.values().stream().findFirst()
                .orElseThrow(() -> new IllegalStateException("No agents loaded"));
    }

    public Collection<Agent> all() { return agents.values(); }
}
