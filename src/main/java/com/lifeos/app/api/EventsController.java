package com.lifeos.app.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.lifeos.agentfleet.EventBus;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

@RestController
@RequestMapping("/api")
public class EventsController {

    private final EventBus eventBus;
    private final ObjectMapper mapper = new ObjectMapper();

    public EventsController(EventBus eventBus) {
        this.eventBus = eventBus;
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
