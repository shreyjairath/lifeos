package com.lifeos.agent;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Loads prompt files with a 3-tier override chain:
 *
 *   load(name)       — /prompt-parts/{name} (classpath only)
 *   load(base, name) — /{base}/{name} (classpath)
 *                    → {base}/{name} (filesystem, for .user-data agents)
 *                    → /prompt-parts/{name} (generic fallback)
 */
public final class PromptParts {

    private PromptParts() {}

    /**
     * Loads a prompt file with override chain:
     *   1. Classpath /{base}/{name}
     *   2. Filesystem {base}/{name}
     *   3. Classpath /prompt-parts/{name}  (generic fallback)
     */
    public static String load(String base, String name) {
        try (var stream = PromptParts.class.getResourceAsStream("/" + base + "/" + name)) {
            if (stream != null) return new String(stream.readAllBytes(), StandardCharsets.UTF_8).strip();
        } catch (IOException ignored) {}
        try {
            var file = Path.of(base, name);
            if (Files.exists(file)) return Files.readString(file, StandardCharsets.UTF_8).strip();
        } catch (IOException ignored) {}
        // Generic fallback — only if not already looking in prompt-parts
        if (!"prompt-parts".equals(base)) return load(name);
        return "";
    }

    /** Loads a prompt file from classpath /prompt-parts/{name}. */
    public static String load(String name) {
        return load("prompt-parts", name);
    }
}
