package com.lifeos.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

public record ChatRequest(
    @JsonProperty("conv_id")    String convId,
    @JsonProperty("session_id") String sessionId,
    String message
) {}
