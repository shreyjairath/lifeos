package com.lifeos.core;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Loads prompt files from classpath, with .user-data/ overrides.
 * Also manages the active-instructions pointer.
 *
 * Two variants:
 *   load(name)             — classpath /prompt-parts/{name}, override .user-data/prompt-parts/{name}
 *   load(base, name)       — classpath /{base}/{name},        override .user-data/{base}/{name}
 */
public final class PromptParts {

    private static final Path USER_DATA = Path.of(System.getProperty("user.dir")).resolve(".user-data");
    private static final Path PROMPT_PARTS_DIR = USER_DATA.resolve("prompt-parts");
    private static final Path ACTIVE_INSTRUCTIONS_FILE = PROMPT_PARTS_DIR.resolve(".active-instructions");
    private static final String DEFAULT_INSTRUCTIONS = "assistant-instructions.md";

    private PromptParts() {}

    /** Loads a prompt file from classpath /{base}/{name}, with .user-data/{base}/{name} override. */
    public static String load(String base, String name) {
        var override = USER_DATA.resolve(base).resolve(name);
        if (Files.exists(override)) {
            try { return Files.readString(override, StandardCharsets.UTF_8).strip(); } catch (IOException ignored) {}
        }
        try (var stream = PromptParts.class.getResourceAsStream("/" + base + "/" + name)) {
            if (stream == null) return "";
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8).strip();
        } catch (IOException e) {
            return "";
        }
    }

    /** Loads a prompt-part by name. Checks .user-data/prompt-parts/ override first, then classpath. */
    public static String load(String name) {
        return load("prompt-parts", name);
    }

    /** Returns the active instructions filename, falling back to the default. */
    public static String loadActiveInstructions() {
        if (Files.exists(ACTIVE_INSTRUCTIONS_FILE)) {
            try {
                var name = Files.readString(ACTIVE_INSTRUCTIONS_FILE, StandardCharsets.UTF_8).strip();
                if (!name.isEmpty()) return name;
            } catch (IOException ignored) {}
        }
        return DEFAULT_INSTRUCTIONS;
    }

    /** Writes the active instructions pointer. */
    public static void saveActiveInstructions(String name) throws IOException {
        Files.createDirectories(PROMPT_PARTS_DIR);
        Files.writeString(ACTIVE_INSTRUCTIONS_FILE, name, StandardCharsets.UTF_8);
    }
}
