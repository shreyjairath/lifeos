package com.lifeos.core.agents;

import com.lifeos.config.AppConfig;
import com.lifeos.core.helpers.EventBus;
import com.lifeos.core.managers.SessionManager;
import com.lifeos.core.managers.WebPushService;
import com.lifeos.core.agents.executor.Cancellation;
import com.lifeos.core.agents.executor.Executor;
import com.lifeos.core.agents.tools.ToolsRegistry;
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
import java.util.Map;

/**
 * Loads agent definitions from classpath: agents/{name}/agent.yml, creates Agent instances,
 * and wires their event listeners. Agents are keyed by name (e.g. "cos", "therapist").
 *
 * To add a new agent: drop an agent.yml in src/main/resources/agents/{name}/. No Java class needed.
 */
@Component
public class AgentRegistry {

    private static final Logger log = LoggerFactory.getLogger(AgentRegistry.class);

    private final Map<String, Agent> agents = new LinkedHashMap<>();

    private final Executor executor;
    private final ToolsRegistry toolsRegistry;
    private final SessionManager session;
    private final EventBus eventBus;
    private final Cancellation cancellation;
    private final AppConfig config;
    private final WebPushService webPush;

    public AgentRegistry(Executor executor, ToolsRegistry toolsRegistry,
                         SessionManager session, EventBus eventBus,
                         Cancellation cancellation, AppConfig config, WebPushService webPush) {
        this.executor = executor;
        this.toolsRegistry = toolsRegistry;
        this.session = session;
        this.eventBus = eventBus;
        this.cancellation = cancellation;
        this.config = config;
        this.webPush = webPush;
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
        var agent = new Agent(def, executor, toolsRegistry, session,
                eventBus, cancellation, config, webPush);
        agent.initListeners();
        agents.put(def.name(), agent);
        log.info("AgentRegistry: loaded agent '{}' from {}", def.name(), promptBase);
        return agent;
    }

    /** Returns the agent with the given name, or the first agent if name is unknown. */
    public Agent get(String name) {
        var agent = agents.get(name);
        if (agent != null) return agent;
        return agents.values().stream().findFirst()
                .orElseThrow(() -> new IllegalStateException("No agents loaded"));
    }

    public Collection<Agent> all() { return agents.values(); }
}
