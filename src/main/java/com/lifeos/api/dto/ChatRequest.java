package com.lifeos.api.dto;

public record ChatRequest(
    String convId,
    String sessionId,
    String message
) {}
