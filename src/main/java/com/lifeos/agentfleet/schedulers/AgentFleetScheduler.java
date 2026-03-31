package com.lifeos.agentfleet.schedulers;

import com.lifeos.agentfleet.AgentFleet;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Fires agentfleet-internal scheduled triggers.
 */
@Component
public class AgentFleetScheduler {

    private static final Logger log = LoggerFactory.getLogger(AgentFleetScheduler.class);

    private final AgentFleet agentFleet;

    public AgentFleetScheduler(AgentFleet agentFleet) {
        this.agentFleet = agentFleet;
    }

    @PostConstruct
    public void initBackgroundTasks() {
        log.info("AgentFleetScheduler: upserting platform background tasks");
        agentFleet.initBackgroundTasks();
    }

    @Scheduled(cron = "${lifeos.session-expiry-check.cron:0 0 * * * *}")
    public void sessionExpiryCheck() {
        log.debug("AgentFleetScheduler.sessionExpiryCheck()");
        agentFleet.checkExpiredSessions();
    }

    @Scheduled(cron = "${lifeos.heartbeat.cron:0 0 */6 * * *}")
    public void heartbeat() {
        log.debug("AgentFleetScheduler.heartbeat()");
        agentFleet.triggerHeartbeat();
    }
}
