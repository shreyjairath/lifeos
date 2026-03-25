package com.lifeos.agentfleet.schedulers;

import com.lifeos.agentfleet.AgentFleet;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Fires agentfleet-internal scheduled triggers.
 * Add a new @Scheduled method to introduce a new platform trigger.
 */
@Component
public class AgentFleetScheduler {

    private static final Logger log = LoggerFactory.getLogger(AgentFleetScheduler.class);

    private final AgentFleet agentFleet;

    public AgentFleetScheduler(AgentFleet agentFleet) {
        this.agentFleet = agentFleet;
    }

    @Scheduled(cron = "${lifeos.session-expiry-check.cron:0 0 * * * *}")
    public void sessionExpiryCheck() {
        log.debug("AgentFleetScheduler.sessionExpiryCheck()");
        agentFleet.checkExpiredSessions();
    }
}
