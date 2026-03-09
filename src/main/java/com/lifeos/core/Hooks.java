package com.lifeos.core;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * Lifecycle hook dispatcher. In the Java port, hooks are implemented as
 * EventBus events rather than dynamic module loading.
 */
@Component
public class Hooks {

    private static final Logger log = LoggerFactory.getLogger(Hooks.class);

    private final EventBus eventBus;

    public Hooks(EventBus eventBus) {
        this.eventBus = eventBus;
    }

    public void fire(String name, Map<String, Object> kwargs) {
        try {
            var event = new java.util.LinkedHashMap<>(kwargs);
            event.put("type", "hook:" + name);
            eventBus.publish(event);
        } catch (Exception e) {
            log.warn("Hook {} raised: {}", name, e.getMessage());
        }
    }
}
