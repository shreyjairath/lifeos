package com.lifeos.executor;

import org.springframework.stereotype.Component;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Per-session cancellation tokens for the agent loop.
 */
@Component
public class Cancellation {

    private final ConcurrentHashMap<String, AtomicBoolean> cancelled = new ConcurrentHashMap<>();

    public void cancel(String sessionId) {
        cancelled.computeIfAbsent(sessionId, k -> new AtomicBoolean()).set(true);
    }

    public boolean isCancelled(String sessionId) {
        AtomicBoolean flag = cancelled.get(sessionId);
        return flag != null && flag.get();
    }

    public void clear(String sessionId) {
        cancelled.remove(sessionId);
    }
}
