package com.lifeos.agentfleet.schedulers;

import com.lifeos.agentfleet.EventBus;
import com.lifeos.agentfleet.tools.Reminders;
import com.lifeos.agentfleet.WebPushService;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.nio.file.Path;
import java.util.Map;

@Component
public class ReminderScheduler {

    private final Reminders reminders;
    private final EventBus eventBus;
    private final WebPushService webPush;

    public ReminderScheduler(EventBus eventBus, WebPushService webPush) {
        this.eventBus = eventBus;
        this.webPush = webPush;
        var systemDir = Path.of(System.getProperty("user.dir")).resolve(".user-data/system").normalize();
        this.reminders = new Reminders(systemDir);
    }

    @Scheduled(fixedDelay = 30_000)
    public void checkDue() {
        for (var r : reminders.pollDue()) {
            var message = (String) r.get("message");
            // In-tab: SSE event for open tabs
            eventBus.publish(Map.of("type", "reminder", "id", r.get("id"), "message", message));
            // Background: Web Push for all subscribed devices
            webPush.sendToAll("lifeos", message);
        }
    }

    public Reminders store() { return reminders; }
}
