package com.lifeos.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.List;
import java.util.Map;

@ConfigurationProperties(prefix = "lifeos")
public record AppConfig(
    String model,
    String backgroundModel,
    String apiKey,
    Session session,
    Reasoning reasoning,
    List<ScheduledTrigger> scheduledTriggers,
    List<McpServer> mcpServers
) {
    public record Session(
        int tokenThreshold,
        int timeThresholdHours
    ) {}

    /**
     * Optional reasoning config sent to OpenRouter for models that support it.
     * Set either effort ("low"/"medium"/"high") or maxTokens, not both.
     */
    public record Reasoning(String effort, Integer maxTokens) {}

    /** A cron-scheduled event published onto the agent event bus. Declared in application.yml. */
    public record ScheduledTrigger(String type, String cron) {}

    /** An MCP server process to launch at startup. Tools are exposed with prefix mcp_<name>_<tool>. */
    public record McpServer(
        String name,
        String command,
        List<String> args,
        Map<String, String> env
    ) {}

    public List<McpServer> mcpServers() {
        return mcpServers != null ? mcpServers : List.of();
    }
}
