package com.lifeos.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.lifeos.core.helpers.EventBus;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api")
public class EventsController {

    private final EventBus eventBus;
    private final ObjectMapper mapper = new ObjectMapper();

    public EventsController(EventBus eventBus) {
        this.eventBus = eventBus;
    }

    @GetMapping("/events/history")
    public List<Map<String, Object>> history() {
        return eventBus.getHistory();
    }

    @GetMapping(value = "/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> events() {
        return eventBus.subscribe()
                .map(event -> {
                    try {
                        return ServerSentEvent.<String>builder()
                                .data(mapper.writeValueAsString(event))
                                .build();
                    } catch (Exception e) {
                        return ServerSentEvent.<String>builder()
                                .data("{\"type\":\"error\"}")
                                .build();
                    }
                });
    }
}
