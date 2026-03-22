package com.lifeos.agentfleet.schedulers;

import com.lifeos.agentfleet.AgentEvents;
import com.lifeos.agentfleet.EventBus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * Fires agentfleet-internal scheduled triggers.
 * Add a new @Scheduled method + AgentEvents constant to introduce a new platform trigger.
 */
@Component
public class AgentFleetScheduler {

    private static final Logger log = LoggerFactory.getLogger(AgentFleetScheduler.class);

    private final EventBus eventBus;

    public AgentFleetScheduler(EventBus eventBus) {
        this.eventBus = eventBus;
    }

    @Scheduled(cron = "${lifeos.session-expiry-check.cron:0 0 * * * *}")
    public void sessionExpiryCheck() {
        log.debug("AgentFleetScheduler.sessionExpiryCheck()");
        eventBus.publish(Map.of("type", AgentEvents.SESSION_EXPIRY_TRIGGER));
    }
}
