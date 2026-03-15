package com.lifeos.core;

import com.lifeos.agents.agent_therapist.Therapist;
import com.lifeos.agents.ProjectsReflector;
import com.lifeos.agents.SessionSummarizer;
import com.lifeos.config.AppConfig;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Orchestrates all post-session reflection: therapist notes, projects, and session summary.
 * ChatManager calls this once at rotation; the details of which agents run and how stay here.
 */
@Component
public class ReflectionManager {

    private final Therapist therapist;
    private final ProjectsReflector projectsReflector;
    private final SessionSummarizer sessionSummarizer;
    private final AppConfig config;

    public ReflectionManager(Therapist therapist,
                             ProjectsReflector projectsReflector,
                             SessionSummarizer sessionSummarizer,
                             AppConfig config) {
        this.therapist = therapist;
        this.projectsReflector = projectsReflector;
        this.sessionSummarizer = sessionSummarizer;
        this.config = config;
    }

    /**
     * Runs all reflection agents for the given session.
     * Returns a combined human-readable summary of what was persisted, or null if nothing.
     */
    public String run(String sessionId, List<Map<String, Object>> history) {
        var transcript = SessionManager.buildTranscript(history);
        if (transcript.isBlank()) return null;

        var therapistSummary = therapist.reflect(transcript);
        var projectsSummary  = config.reflect() != null && config.reflect().projectsEnabled()
                ? projectsReflector.run(transcript) : null;
        sessionSummarizer.run(sessionId, transcript);

        var parts = new ArrayList<String>();
        if (therapistSummary != null) parts.add(therapistSummary);
        if (projectsSummary != null)  parts.add(projectsSummary);
        return parts.isEmpty() ? null : String.join("\n", parts);
    }
}
