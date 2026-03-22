package com.lifeos.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "lifeos")
public record AppConfig(
    String model,
    String backgroundModel,
    String anthropicApiKey,
    Session session,
    java.util.List<ScheduledTrigger> scheduledTriggers
) {
    public record Session(
        int tokenThreshold,
        int timeThresholdHours
    ) {}

    /** A cron-scheduled event published onto the agent event bus. Declared in application.yml. */
    public record ScheduledTrigger(String type, String cron) {}
}
