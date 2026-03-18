package com.lifeos.core.managers;

import com.lifeos.core.helpers.EventBus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * Emits a `heartbeat_trigger` event on a fixed schedule (default every 30 minutes).
 *
 * Downstream listeners react independently:
 *   SessionManager  — scans for expired sessions, emits `session_closed` for each
 *   ReflectionManager — listens to `session_closed`, runs reflection
 *   BaseAgent (each) — listens to `heartbeat_trigger`, runs its own heartbeat check
 */
@Component
public class HeartbeatScheduler {

    private static final Logger log = LoggerFactory.getLogger(HeartbeatScheduler.class);

    private final EventBus eventBus;

    public HeartbeatScheduler(EventBus eventBus) {
        this.eventBus = eventBus;
    }

    @Scheduled(fixedDelayString = "${lifeos.heartbeat.interval-ms:14400000}")
    public void tick() {
        log.debug("HeartbeatScheduler.tick()");
        eventBus.publish(Map.of("type", "heartbeat_trigger"));
    }
}
