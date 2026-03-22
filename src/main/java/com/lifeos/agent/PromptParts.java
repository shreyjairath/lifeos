package com.lifeos.agent;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Loads prompt files from classpath, with filesystem fallback for dynamically created agents.
 *
 * Two variants:
 *   load(name)       — classpath /prompt-parts/{name}
 *   load(base, name) — classpath /{base}/{name}, fallback to filesystem {base}/{name}
 */
public final class PromptParts {

    private PromptParts() {}

    /** Loads a prompt file from classpath /{base}/{name}, falling back to filesystem {base}/{name}. */
    public static String load(String base, String name) {
        try (var stream = PromptParts.class.getResourceAsStream("/" + base + "/" + name)) {
            if (stream != null) return new String(stream.readAllBytes(), StandardCharsets.UTF_8).strip();
        } catch (IOException ignored) {}
        try {
            var file = Path.of(base, name);
            if (Files.exists(file)) return Files.readString(file, StandardCharsets.UTF_8).strip();
        } catch (IOException ignored) {}
        return "";
    }

    /** Loads a prompt file from classpath /prompt-parts/{name}. */
    public static String load(String name) {
        return load("prompt-parts", name);
    }
}
