package com.lifeos.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "lifeos")
public record AppConfig(
    String model,
    String backgroundModel,
    String apiKey,
    Session session,
    Reasoning reasoning,
    java.util.List<ScheduledTrigger> scheduledTriggers
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
}
