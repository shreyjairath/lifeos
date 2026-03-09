package com.lifeos.tools;

import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

/**
 * Read/write named knowledge files (identity, routines, tools, services, integrations).
 */
@Component
public class KnowledgeFiles {

    private static final Path USER_DATA = Path.of(System.getProperty("user.dir"))
            .resolve("../.user-data").normalize();

    private static final Map<String, String[]> ALLOWED_FILES = Map.of(
            "identity", new String[]{"user", "identity.md"},
            "routines", new String[]{"user", "routines.md"},
            "tools", new String[]{"environment", "tools.md"},
            "services", new String[]{"environment", "services.md"},
            "integrations", new String[]{"environment", "integrations.md"}
    );

    public Map<String, Object> read(String fileKey) {
        var parts = ALLOWED_FILES.get(fileKey);
        if (parts == null) return Map.of("error", "Unknown file: " + fileKey);
        try {
            var path = USER_DATA.resolve(parts[0]).resolve(parts[1]);
            if (!Files.exists(path)) return Map.of("file", fileKey, "content", "");
            return Map.of("file", fileKey, "content", Files.readString(path, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> update(String fileKey, String content) {
        var parts = ALLOWED_FILES.get(fileKey);
        if (parts == null) return Map.of("error", "Unknown file: " + fileKey);
        try {
            var path = USER_DATA.resolve(parts[0]).resolve(parts[1]);
            Files.createDirectories(path.getParent());
            Files.writeString(path, content, StandardCharsets.UTF_8);
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
