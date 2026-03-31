package com.lifeos.agentfleet.tools;

import com.lifeos.agentfleet.AgentRegistry;
import com.lifeos.agentfleet.EventBus;
import com.lifeos.agent.PushNotifier;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Provides the notify_user tool — lets agents send an immediate notification to the user
 * from background modes (heartbeat, post-session). Replaces the fragile push_to_user text protocol.
 *
 * Fires both a web push notification (works when browser is closed) and an SSE "notification"
 * event (rendered as a toast when browser is open).
 */
@Component
public class Notifications {

    private final AgentRegistry agentRegistry;
    private final EventBus eventBus;
    private final PushNotifier webPush;

    public Notifications(@Lazy AgentRegistry agentRegistry, EventBus eventBus, PushNotifier webPush) {
        this.agentRegistry = agentRegistry;
        this.eventBus = eventBus;
        this.webPush = webPush;
    }

    public Map<String, Object> notifyUser(String agentName, String message, String urgency, String context) {
        if (message == null || message.isBlank())
            return Map.of("error", "message is required");

        var agent = agentRegistry.get(agentName);
        var agentTitle = agent != null ? agent.getTitle() : agentName;
        var urg = urgency != null ? urgency : "medium";

        // Web push — fires even when browser is closed
        webPush.sendToAll(agentTitle, message);

        // SSE event — renders as toast when browser is open
        var event = new LinkedHashMap<String, Object>();
        event.put("type", "notification");
        event.put("agent", agentName);
        event.put("agentTitle", agentTitle);
        event.put("message", message);
        event.put("urgency", urg);
        if (context != null && !context.isBlank()) event.put("context", context);
        eventBus.publish(event);

        return Map.of("status", "sent", "title", agentTitle, "message", message);
    }
}
