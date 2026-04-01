package com.lifeos.agentfleet.tools;

import com.lifeos.config.AppConfig;
import io.modelcontextprotocol.client.McpClient;
import io.modelcontextprotocol.client.McpSyncClient;
import io.modelcontextprotocol.client.transport.ServerParameters;
import io.modelcontextprotocol.client.transport.StdioClientTransport;
import io.modelcontextprotocol.json.McpJsonMapperSupplier;
import io.modelcontextprotocol.spec.McpSchema.CallToolRequest;
import io.modelcontextprotocol.spec.McpSchema.Content;
import io.modelcontextprotocol.spec.McpSchema.Implementation;
import io.modelcontextprotocol.spec.McpSchema.JsonSchema;
import io.modelcontextprotocol.spec.McpSchema.TextContent;
import io.modelcontextprotocol.spec.McpSchema.Tool;
import io.modelcontextprotocol.util.McpServiceLoader;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

/**
 * Connects to configured MCP server subprocesses at startup, discovers their tools,
 * and proxies tool calls. Tools are exposed with the prefix mcp_<serverName>_<toolName>.
 */
@Component
public class McpToolsClient {

    private static final Logger log = LoggerFactory.getLogger(McpToolsClient.class);

    private final AppConfig config;
    private final List<Map<String, Object>> allTools = new ArrayList<>();
    private final Map<String, McpSyncClient> toolClients = new ConcurrentHashMap<>();
    private final Map<String, String> toolOriginalNames = new ConcurrentHashMap<>();
    private final List<McpSyncClient> clients = new ArrayList<>();

    public McpToolsClient(AppConfig config) {
        this.config = config;
    }

    @PostConstruct
    public void init() {
        var jsonMapper = new McpServiceLoader<>(McpJsonMapperSupplier.class).getDefault();
        for (var server : config.mcpServers()) {
            try {
                var params = new ServerParameters.Builder(server.command())
                        .args(server.args() != null ? server.args() : List.of())
                        .env(server.env() != null ? server.env() : Map.of())
                        .build();
                var transport = new StdioClientTransport(params, jsonMapper);
                var client = McpClient.sync(transport)
                        .clientInfo(new Implementation("lifeos", "1.0"))
                        .build();
                client.initialize();
                clients.add(client);

                var tools = client.listTools().tools();
                for (var tool : tools) {
                    var prefixedName = "mcp_" + server.name() + "_" + tool.name();
                    allTools.add(toAnthropicFormat(prefixedName, tool));
                    toolClients.put(prefixedName, client);
                    toolOriginalNames.put(prefixedName, tool.name());
                }
                log.info("McpToolsClient: registered {} tools from server '{}'", tools.size(), server.name());
            } catch (Exception e) {
                log.warn("McpToolsClient: failed to connect to server '{}': {}", server.name(), e.getMessage());
            }
        }
    }

    public List<Map<String, Object>> getTools() {
        return List.copyOf(allTools);
    }

    public Map<String, Object> callTool(String prefixedName, Map<String, Object> input) {
        var client = toolClients.get(prefixedName);
        var originalName = toolOriginalNames.get(prefixedName);
        if (client == null) return Map.of("error", "Unknown MCP tool: " + prefixedName);
        try {
            var result = client.callTool(new CallToolRequest(originalName, input != null ? input : Map.of()));
            var text = result.content().stream()
                    .filter(c -> c instanceof TextContent)
                    .map(c -> ((TextContent) c).text())
                    .collect(Collectors.joining("\n"));
            return Map.of("result", text);
        } catch (Exception e) {
            return Map.of("error", e.getMessage() != null ? e.getMessage() : "MCP tool call failed");
        }
    }

    @PreDestroy
    public void shutdown() {
        clients.forEach(c -> {
            try { c.close(); } catch (Exception ignored) {}
        });
    }

    private Map<String, Object> toAnthropicFormat(String prefixedName, Tool tool) {
        return Map.of(
                "name", prefixedName,
                "description", tool.description() != null ? tool.description() : "",
                "input_schema", convertSchema(tool.inputSchema())
        );
    }

    private Map<String, Object> convertSchema(JsonSchema schema) {
        if (schema == null) return Map.of("type", "object", "properties", Map.of());
        var result = new LinkedHashMap<String, Object>();
        result.put("type", schema.type() != null ? schema.type() : "object");
        if (schema.properties() != null) result.put("properties", schema.properties());
        if (schema.required() != null && !schema.required().isEmpty()) result.put("required", schema.required());
        return result;
    }
}
