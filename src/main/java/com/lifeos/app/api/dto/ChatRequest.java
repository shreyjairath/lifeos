package com.lifeos.app.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

public record ChatRequest(
    @JsonProperty("session_id") String sessionId,
    String message,
    String agent,
    String model   // nullable — null means "use agent/global default"
) {}
