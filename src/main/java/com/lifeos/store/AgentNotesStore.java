package com.lifeos.store;

import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.stream.Stream;

/**
 * Raw file I/O for the knowledge subtree: .user-data/knowledge/
 */
@Component
public class AgentNotesStore {

    private static final Path KNOWLEDGE = Path.of(System.getProperty("user.dir"))
            .resolve(".user-data/knowledge").normalize();

    // ── Notes directory ───────────────────────────────────────────────────────

    private static final Path NOTES = KNOWLEDGE.resolve("notes");

    public List<String> listNotes() {
        if (!Files.exists(NOTES)) return List.of();
        try (Stream<Path> files = Files.list(NOTES).sorted()) {
            return files.filter(Files::isRegularFile)
                    .map(p -> p.getFileName().toString())
                    .toList();
        } catch (IOException e) {
            return List.of();
        }
    }

    public String readNote(String filename) {
        var path = NOTES.resolve(filename);
        if (!Files.exists(path)) return null;
        try {
            return Files.readString(path, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return null;
        }
    }

    public void writeNote(String filename, String content) {
        var path = NOTES.resolve(filename);
        try {
            // Haiku sometimes double-escapes newlines (\\n instead of \n in JSON),
            // resulting in literal backslash-n. Unescape common sequences before writing.
            content = content.replace("\\n", "\n").replace("\\t", "\t");
            Files.createDirectories(NOTES);
            Files.writeString(path, content, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to write note: " + filename, e);
        }
    }

    public boolean deleteNote(String filename) {
        var path = NOTES.resolve(filename);
        try {
            return Files.deleteIfExists(path);
        } catch (IOException e) {
            return false;
        }
    }

    /** Returns map of filename → list of matching lines (with 1-based line numbers). */
    public Map<String, List<String>> grepNotes(String pattern) {
        var results = new LinkedHashMap<String, List<String>>();
        if (!Files.exists(NOTES)) return results;
        var regex = java.util.regex.Pattern.compile(pattern, java.util.regex.Pattern.CASE_INSENSITIVE);
        for (var filename : listNotes()) {
            var content = readNote(filename);
            if (content == null) continue;
            var lines = content.split("\n", -1);
            var matches = new ArrayList<String>();
            for (int i = 0; i < lines.length; i++) {
                if (regex.matcher(lines[i]).find()) {
                    matches.add((i + 1) + ": " + lines[i]);
                }
            }
            if (!matches.isEmpty()) results.put(filename, matches);
        }
        return results;
    }

    // ── Path helpers ──────────────────────────────────────────────────────────

    public Path knowledgeRoot() { return KNOWLEDGE; }
    public Path notesDir() { return NOTES; }
}
