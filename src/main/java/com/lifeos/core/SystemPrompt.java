package com.lifeos.core;

import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * Assembles the full system prompt: persona + knowledge + onboarding + parent session context.
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

    public String prepare(String sessionId) {
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

        var parentSummary = session.getParentSummary(sessionId);
        if (parentSummary.isPresent()) {
            var s = parentSummary.get();
            eventBus.publish(Map.of("type", "knowledge_file", "file", "last_session",
                    "label", "Last Session", "status", "loaded", "chars", s.content().length()));
            system += "\n\n# Session Context\n\n## Last Session — " + s.dateStr() + "\n\n" + s.content();
        }

        system = system.strip();
        eventBus.publish(Map.of("type", "system_prompt", "chars", system.length()));
        eventBus.publish(Map.of("type", "boot_done"));
        return system;
    }
}
