package com.lifeos.agentfleet;

/**
 * Event type strings published by agentfleet's own schedulers.
 * Application-level event types (heartbeat, self-eval, etc.) belong in the app layer.
 */
public final class AgentEvents {
    public static final String SESSION_EXPIRY_TRIGGER = "session_expiry_check_trigger";

    private AgentEvents() {}
}
