package com.lifeos.core.agents;

import com.lifeos.core.helpers.PromptParts;
import com.lifeos.core.agents.executor.LlmClient;
import com.lifeos.core.store.SessionStore;
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
    private static final String PROMPT_BASE = "agents/session_summarizer";
    private static final String SUMMARIZE_FILE = "summarize.md";

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
            llmClient.stream(MODEL, PromptParts.load(PROMPT_BASE, SUMMARIZE_FILE),
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
            llmClient.stream(MODEL, "Reply with only a short session title (4-6 words, no punctuation, no quotes).",
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
