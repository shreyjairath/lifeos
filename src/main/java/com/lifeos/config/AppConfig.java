package com.lifeos.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "lifeos")
public record AppConfig(
    String model,
    String anthropicApiKey,
    Paths paths,
    Session session,
    Reflect reflect
) {
    public record Paths(
        String environment,
        String user
    ) {}

    public record Session(
        int tokenThreshold,
        int timeThresholdHours
    ) {}

    public record Reflect(
        boolean projectsEnabled
    ) {}
}
