package com.lifeos.core;

import com.lifeos.agents.NotesReflector;
import com.lifeos.agents.ProjectsReflector;
import com.lifeos.agents.SessionSummarizer;
import com.lifeos.config.AppConfig;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Orchestrates all post-session reflection: notes, projects, and session summary.
 * ChatManager calls this once at rotation; the details of which agents run and how stay here.
 */
@Component
public class ReflectionManager {

    private final NotesReflector notesReflector;
    private final ProjectsReflector projectsReflector;
    private final SessionSummarizer sessionSummarizer;
    private final AppConfig config;

    public ReflectionManager(NotesReflector notesReflector,
                             ProjectsReflector projectsReflector,
                             SessionSummarizer sessionSummarizer,
                             AppConfig config) {
        this.notesReflector = notesReflector;
        this.projectsReflector = projectsReflector;
        this.sessionSummarizer = sessionSummarizer;
        this.config = config;
    }

    /**
     * Runs all reflection agents for the given session.
     * Returns a combined human-readable summary of what was persisted, or null if nothing.
     */
    public String run(String sessionId, List<Map<String, Object>> history, String pendingMessage) {
        var transcript = SessionManager.buildTranscript(history);
        if (transcript.isBlank()) return null;

        if (pendingMessage != null && !pendingMessage.isEmpty()) {
            transcript += "\n\nUSER (pending — triggered session rotation): " + pendingMessage;
        }

        var notesSummary    = notesReflector.run(history);
        var projectsSummary = config.reflect() != null && config.reflect().projectsEnabled()
                ? projectsReflector.run(history) : null;
        sessionSummarizer.run(sessionId, transcript);

        var parts = new ArrayList<String>();
        if (notesSummary != null)    parts.add(notesSummary);
        if (projectsSummary != null) parts.add(projectsSummary);
        return parts.isEmpty() ? null : String.join("\n", parts);
    }
}
