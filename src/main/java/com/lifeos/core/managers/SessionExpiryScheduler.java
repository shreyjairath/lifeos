package com.lifeos.core.managers;

import com.lifeos.core.helpers.EventBus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * Emits a `session_expiry_trigger` event on a fixed schedule (default every 30 minutes).
 *
 * SessionManager listens and closes any sessions past the inactivity threshold.
 * Decoupled from the agent heartbeat so session close and agent heartbeat don't race.
 */
@Component
public class SessionExpiryScheduler {

    private static final Logger log = LoggerFactory.getLogger(SessionExpiryScheduler.class);

    private final EventBus eventBus;

    public SessionExpiryScheduler(EventBus eventBus) {
        this.eventBus = eventBus;
    }

    @Scheduled(fixedDelayString = "${lifeos.session-expiry.interval-ms:1800000}",
               initialDelayString = "${lifeos.session-expiry.interval-ms:1800000}")
    public void tick() {
        log.debug("SessionExpiryScheduler.tick()");
        eventBus.publish(Map.of("type", "session_expiry_trigger"));
    }
}
