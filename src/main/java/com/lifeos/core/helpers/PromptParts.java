package com.lifeos.core.helpers;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * Loads prompt files from classpath.
 *
 * Two variants:
 *   load(name)       — classpath /prompt-parts/{name}
 *   load(base, name) — classpath /{base}/{name}
 */
public final class PromptParts {

    private PromptParts() {}

    /** Loads a prompt file from classpath /{base}/{name}. */
    public static String load(String base, String name) {
        try (var stream = PromptParts.class.getResourceAsStream("/" + base + "/" + name)) {
            if (stream == null) return "";
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8).strip();
        } catch (IOException e) {
            return "";
        }
    }

    /** Loads a prompt file from classpath /prompt-parts/{name}. */
    public static String load(String name) {
        return load("prompt-parts", name);
    }
}
