package com.lifeos.agents;

import com.lifeos.core.Knowledge;
import com.lifeos.agents.executor.LlmClient;
import com.lifeos.store.SessionStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/**
 * Archives a session by writing a summary to its summary.md.
 * Self-contained: owns its model and prompt.
 */
@Component
public class SessionSummarizer {

    private static final Logger log = LoggerFactory.getLogger(SessionSummarizer.class);
    private static final String MODEL = "claude-haiku-4-5-20251001";

    private final LlmClient llmClient;
    private final SessionStore store;

    public SessionSummarizer(LlmClient llmClient, SessionStore store) {
        this.llmClient = llmClient;
        this.store = store;
    }

    /**
     * Summarizes the session transcript and writes it to summary.md for the given sessionId.
     */
    public void run(String sessionId, String transcript) {
        if (transcript.isBlank()) return;
        try {
            var result = new LlmClient.LlmResult();
            llmClient.stream(MODEL, Knowledge.loadPromptPart("summarize-session.md"),
                    List.of(Map.<String, Object>of("role", "user", "content", transcript)),
                    List.of(), 1024, result).blockLast();
            if (!result.getFullText().isEmpty()) {
                store.writeSummary(sessionId, result.getFullText());
            }
        } catch (Exception e) {
            log.warn("Session summary failed for {}: {}", sessionId, e.getMessage());
        }
    }
}
