package com.lifeos.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "lifeos")
public record AppConfig(
    String model,
    String backgroundModel,
    String anthropicApiKey,
    Session session
) {
    public record Session(
        int tokenThreshold,
        int timeThresholdHours
    ) {}
}
