package com.lifeos.core.managers;

import com.lifeos.core.agents.AgentAssistant;
import com.lifeos.core.agents.AgentTherapist;
import com.lifeos.core.agents.SessionSummarizer;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Orchestrates all post-session reflection: per-agent notes and session summary.
 * ChatManager calls this once at rotation; the details of which agents run and how stay here.
 */
@Component
public class ReflectionManager {

    private final AgentAssistant agentMain;
    private final AgentTherapist agentTherapist;
    private final SessionSummarizer sessionSummarizer;

    public ReflectionManager(AgentAssistant agentMain, AgentTherapist agentTherapist,
                             SessionSummarizer sessionSummarizer) {
        this.agentMain = agentMain;
        this.agentTherapist = agentTherapist;
        this.sessionSummarizer = sessionSummarizer;
    }

    /**
     * Runs all reflection agents for the given session.
     * Returns a human-readable summary of what was persisted, or null if nothing.
     */
    public String run(String sessionId, List<Map<String, Object>> history) {
        var transcript = SessionManager.buildTranscript(history);
        if (transcript.isBlank()) return null;

        var parts = new ArrayList<String>();
        for (var agent : List.of(agentMain, agentTherapist)) {
            var s = agent.reflect(transcript);
            if (s != null) parts.add(s);
        }

        sessionSummarizer.run(sessionId, transcript);
        return parts.isEmpty() ? null : String.join("\n\n", parts);
    }
}
