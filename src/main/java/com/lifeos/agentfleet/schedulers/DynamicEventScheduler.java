package com.lifeos.agentfleet.schedulers;

import com.lifeos.agentfleet.EventBus;
import com.lifeos.config.AppConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.SchedulingConfigurer;
import org.springframework.scheduling.config.ScheduledTaskRegistrar;

import java.util.Map;

/**
 * Reads scheduled-triggers from application.yml and registers them as cron tasks on the event bus.
 * The app declares what events to fire and when; agentfleet handles the scheduling.
 */
@Configuration
public class DynamicEventScheduler implements SchedulingConfigurer {

    private static final Logger log = LoggerFactory.getLogger(DynamicEventScheduler.class);

    private final EventBus eventBus;
    private final AppConfig config;

    public DynamicEventScheduler(EventBus eventBus, AppConfig config) {
        this.eventBus = eventBus;
        this.config = config;
    }

    @Override
    public void configureTasks(ScheduledTaskRegistrar registrar) {
        for (var trigger : config.scheduledTriggers()) {
            var type = trigger.type();
            var cron = trigger.cron();
            log.info("DynamicEventScheduler: registering '{}' on cron '{}'", type, cron);
            registrar.addCronTask(
                    () -> eventBus.publish(Map.of("type", type)),
                    cron);
        }
    }
}
