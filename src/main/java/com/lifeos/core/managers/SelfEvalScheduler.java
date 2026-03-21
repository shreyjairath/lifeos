package com.lifeos.core.managers;

import com.lifeos.core.helpers.EventBus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * Emits a `self_eval_trigger` event on a fixed schedule (default every 24 hours).
 *
 * Agents that define a selfEvalPrompt() will react independently to perform
 * a quality self-assessment and course-correct their operating picture.
 * Unlike the heartbeat (which checks for urgent items), self-eval is for
 * deeper reflection on how well the agent is doing its job.
 */
@Component
public class SelfEvalScheduler {

    private static final Logger log = LoggerFactory.getLogger(SelfEvalScheduler.class);

    private final EventBus eventBus;

    public SelfEvalScheduler(EventBus eventBus) {
        this.eventBus = eventBus;
    }

    @Scheduled(cron = "${lifeos.self-eval.cron:0 0 5 * * *}")
    public void tick() {
        log.debug("SelfEvalScheduler.tick()");
        eventBus.publish(Map.of("type", "self_eval_trigger"));
    }
}
