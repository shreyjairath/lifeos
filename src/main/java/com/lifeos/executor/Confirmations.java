package com.lifeos.executor;

import org.springframework.stereotype.Component;

import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Async confirmation gate for tools that require user approval.
 */
@Component
public class Confirmations {

    private static final Set<String> GATED_TOOLS = Set.of("run_python", "claude_code");
    private static final Set<String> GATED_PREFIXES = Set.of("chrome_");
    private static final long TIMEOUT_SECONDS = 120;

    private final ConcurrentHashMap<String, CompletableFuture<Boolean>> pending = new ConcurrentHashMap<>();

    public boolean isGated(String toolName) {
        if (GATED_TOOLS.contains(toolName)) return true;
        return GATED_PREFIXES.stream().anyMatch(toolName::startsWith);
    }

    public String register() {
        String requestId = UUID.randomUUID().toString();
        pending.put(requestId, new CompletableFuture<>());
        return requestId;
    }

    /**
     * Blocks until the confirmation is resolved or times out.
     * Returns true if approved, false if denied or timed out.
     */
    public boolean waitFor(String requestId) {
        CompletableFuture<Boolean> future = pending.get(requestId);
        if (future == null) return false;
        try {
            return future.get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (TimeoutException e) {
            pending.remove(requestId);
            return false;
        } catch (Exception e) {
            pending.remove(requestId);
            return false;
        }
    }

    /**
     * Called by the API endpoint when the user approves/denies.
     */
    public boolean resolve(String requestId, boolean approved) {
        CompletableFuture<Boolean> future = pending.remove(requestId);
        if (future == null) return false;
        future.complete(approved);
        return true;
    }
}
