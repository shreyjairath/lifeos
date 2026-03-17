package com.lifeos.core.agents;

import com.lifeos.config.AppConfig;
import com.lifeos.core.helpers.EventBus;
import com.lifeos.core.helpers.PromptParts;
import com.lifeos.core.agents.executor.LlmClient;
import com.lifeos.core.managers.SessionManager;
import com.lifeos.core.store.SessionStore;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import reactor.core.scheduler.Schedulers;

import java.util.List;
import java.util.Map;

/**
 * Archives a session by writing a summary and title to its session directory.
 * Subscribes to `session_closed` events and handles summarization independently.
 */
@Component
public class SessionSummarizer {

    private static final Logger log = LoggerFactory.getLogger(SessionSummarizer.class);
    private static final String DEFAULT_MODEL = "claude-haiku-4-5-20251001";
    private static final String PROMPT_BASE = "agents/session_summarizer";
    private static final String SUMMARIZE_FILE = "summarize.md";

    private final LlmClient llmClient;
    private final SessionStore store;
    private final SessionManager sessionManager;
    private final EventBus eventBus;
    private final AppConfig config;

    public SessionSummarizer(LlmClient llmClient, SessionStore store,
                             SessionManager sessionManager, EventBus eventBus,
                             AppConfig config) {
        this.llmClient = llmClient;
        this.store = store;
        this.sessionManager = sessionManager;
        this.eventBus = eventBus;
        this.config = config;
    }

    private String model() {
        var m = config.reflectModel();
        return (m != null && !m.isBlank()) ? m : DEFAULT_MODEL;
    }

    @PostConstruct
    public void initSessionClosedListener() {
        eventBus.subscribe()
                .filter(e -> "session_closed".equals(e.get("type")))
                .publishOn(Schedulers.boundedElastic())
                .subscribe(
                        e -> {
                            var sessionId = (String) e.get("sessionId");
                            var transcript = SessionManager.buildTranscript(
                                    sessionManager.getHistory(sessionId));
                            run(sessionId, transcript);
                        },
                        err -> log.warn("SessionSummarizer session_closed stream error: {}", err.getMessage()));
    }

    public void run(String sessionId, String transcript) {
        if (transcript.isBlank()) return;
        try {
            var result = new LlmClient.LlmResult();
            llmClient.stream(model(), PromptParts.load(PROMPT_BASE, SUMMARIZE_FILE),
                    List.of(Map.<String, Object>of("role", "user", "content", transcript)),
                    List.of(), 1024, result).blockLast();
            if (!result.getFullText().isEmpty()) {
                store.writeSummary(sessionId, result.getFullText());
            }
        } catch (Exception e) {
            log.warn("Session summary failed for {}: {}", sessionId, e.getMessage());
        }
        try {
            var titleResult = new LlmClient.LlmResult();
            llmClient.stream(model(), "Reply with only a short session title (4-6 words, no punctuation, no quotes).",
                    List.of(Map.<String, Object>of("role", "user", "content", transcript)),
                    List.of(), 32, titleResult).blockLast();
            var title = titleResult.getFullText().strip();
            if (!title.isEmpty()) {
                var meta = new java.util.LinkedHashMap<>(store.loadMeta(sessionId));
                meta.put("title", title);
                store.saveMeta(sessionId, meta);
            }
        } catch (Exception e) {
            log.warn("Session title failed for {}: {}", sessionId, e.getMessage());
        }
    }
}
