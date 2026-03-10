package com.lifeos.tools;

import com.lifeos.store.KnowledgeStore;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * Read/write named knowledge files (identity, routines, environment).
 */
@Component
public class KnowledgeFiles {

    private static final Map<String, String[]> ALLOWED_FILES = Map.of(
            "identity",    new String[]{"user", "identity.md"},
            "routines",    new String[]{"user", "routines.md"},
            "environment", new String[]{"environment", "environment.md"}
    );

    private final KnowledgeStore store;

    public KnowledgeFiles(KnowledgeStore store) { this.store = store; }

    public Map<String, Object> read(String fileKey) {
        var parts = ALLOWED_FILES.get(fileKey);
        if (parts == null) return Map.of("error", "Unknown file: " + fileKey);
        try {
            return Map.of("file", fileKey, "content", store.readText(parts[0], parts[1]));
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> update(String fileKey, String content) {
        var parts = ALLOWED_FILES.get(fileKey);
        if (parts == null) return Map.of("error", "Unknown file: " + fileKey);
        try {
            store.writeText(parts[0], parts[1], content);
            return Map.of("updated", fileKey, "chars", content.length());
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> setOnboardingStatus(String fileKey, String status) {
        // TODO: persist onboarding status
        return Map.of("file", fileKey, "status", status);
    }
}
