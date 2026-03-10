package com.lifeos.core;

import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Map;

/**
 * Assembles the full system prompt from parts: persona, knowledge, onboarding, session context.
 */
@Component
public class SystemPrompt {

    private final Knowledge knowledge;
    private final Session session;
    private final EventBus eventBus;

    public SystemPrompt(Knowledge knowledge, Session session, EventBus eventBus) {
        this.knowledge = knowledge;
        this.session = session;
        this.eventBus = eventBus;
    }

    public String prepare(String convId) {
        eventBus.publish(Map.of("type", "boot_start"));

        var persona = Knowledge.loadPromptPart("persona.md");
        var knowledgeSection = knowledge.getKnowledgeSection();
        var incompleteTopics = knowledge.incompleteOnboardingTopics();

        String system;
        if (!incompleteTopics.isEmpty()) {
            system = persona + "\n\n" + knowledgeSection + "\n\n" + knowledge.getOnboardingSection(incompleteTopics);
        } else {
            system = persona + "\n\n" + knowledgeSection;
        }

        var sessionContext = loadSessionContext(convId);
        if (!sessionContext.isEmpty()) {
            system += "\n\n" + sessionContext;
        }

        system = system.strip();
        eventBus.publish(Map.of("type", "system_prompt", "chars", system.length()));
        eventBus.publish(Map.of("type", "boot_done"));
        return system;
    }


    // ── Private ──────────────────────────────────────────────────────────────────

    private String loadSessionContext(String convId) {
        if (convId == null || convId.isEmpty()) return "";
        var sections = new ArrayList<String>();

        var convSummary = session.getConvSummary(convId);
        if (!convSummary.isEmpty()) {
            eventBus.publish(Map.of("type", "knowledge_file", "file", "conv_summary",
                    "label", "Conversation Summary", "status", "loaded", "chars", convSummary.length()));
            sections.add("## Conversation Summary\n\n" + convSummary);
        }

        session.getLastSessionSummary(convId).ifPresent(s -> {
            eventBus.publish(Map.of("type", "knowledge_file", "file", "last_session",
                    "label", "Last Session", "status", "loaded", "chars", s.content().length()));
            sections.add("## Last Session — " + s.dateStr() + "\n\n" + s.content());
        });

        if (sections.isEmpty()) return "";
        return "# Session Context\n\n" + String.join("\n\n", sections);
    }
}
