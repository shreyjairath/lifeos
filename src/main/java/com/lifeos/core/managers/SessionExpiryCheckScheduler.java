package com.lifeos.core.managers;

import com.lifeos.core.helpers.EventBus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * Emits a `session_expiry_check_trigger` event on a fixed schedule (default every 4 hours).
 *
 * SessionManager listens and closes any sessions past the inactivity threshold.
 * Decoupled from the agent heartbeat so session close and agent heartbeat don't race.
 */
@Component
public class SessionExpiryCheckScheduler {

    private static final Logger log = LoggerFactory.getLogger(SessionExpiryCheckScheduler.class);

    private final EventBus eventBus;

    public SessionExpiryCheckScheduler(EventBus eventBus) {
        this.eventBus = eventBus;
    }

    @Scheduled(fixedDelayString = "${lifeos.session-expiry-check.interval-ms:14400000}",
               initialDelayString = "${lifeos.session-expiry-check.interval-ms:14400000}")
    public void tick() {
        log.debug("SessionExpiryCheckScheduler.tick()");
        eventBus.publish(Map.of("type", "session_expiry_check_trigger"));
    }
}
