package com.lifeos.core;

import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Sinks;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * In-memory pub/sub event bus for SSE streaming to the frontend.
 */
@Component
public class EventBus {

    private static final int MAX_HISTORY = 500;

    private final Sinks.Many<Map<String, Object>> sink =
            Sinks.many().multicast().onBackpressureBuffer();

    private final List<Map<String, Object>> history =
            Collections.synchronizedList(new ArrayList<>());

    public void publish(Map<String, Object> event) {
        if (history.size() >= MAX_HISTORY) {
            history.removeFirst();
        }
        history.add(event);
        sink.tryEmitNext(event);
    }

    public Flux<Map<String, Object>> subscribe() {
        return sink.asFlux();
    }

    public List<Map<String, Object>> getHistory() {
        return List.copyOf(history);
    }

    public void shutdown() {
        sink.tryEmitComplete();
    }
}
