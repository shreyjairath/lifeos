package com.lifeos.tools;

import com.lifeos.store.AgentNotesStore;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * Agent tools for the notes directory (.user-data/knowledge/notes/).
 */
@Component
public class KnowledgeFiles {

    private final AgentNotesStore store;

    public KnowledgeFiles(AgentNotesStore store) { this.store = store; }

    public Map<String, Object> listNotes() {
        return Map.of("files", store.listNotes());
    }

    public Map<String, Object> readNote(String filename) {
        if (!safe(filename)) return Map.of("error", "Invalid filename");
        var content = store.readNote(filename);
        if (content == null) return Map.of("error", "Not found: " + filename);
        return Map.of("file", filename, "content", content);
    }

    public Map<String, Object> writeNote(String filename, String content) {
        if (!safe(filename)) return Map.of("error", "Invalid filename");
        try {
            store.writeNote(filename, content);
            return Map.of("file", filename, "status", "saved", "chars", content.length());
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> deleteNote(String filename) {
        if (!safe(filename)) return Map.of("error", "Invalid filename");
        var deleted = store.deleteNote(filename);
        return deleted ? Map.of("deleted", filename) : Map.of("error", "Not found: " + filename);
    }

    public Map<String, Object> grepNotes(String pattern) {
        try {
            var results = store.grepNotes(pattern);
            return Map.of("pattern", pattern, "matches", results);
        } catch (Exception e) {
            return Map.of("error", "Invalid pattern: " + e.getMessage());
        }
    }

    // Legacy single-file access used by KnowledgeController /api/knowledge/agent-notes
    public Map<String, Object> update(String fileKey, String content) {
        if (!"agent-notes".equals(fileKey)) return Map.of("error", "Unknown file: " + fileKey);
        return writeNote(fileKey, content);
    }

    public Map<String, Object> read(String fileKey) {
        if (!"agent-notes".equals(fileKey)) return Map.of("error", "Unknown file: " + fileKey);
        var files = store.listNotes();
        if (files.isEmpty()) return Map.of("file", fileKey, "content", "");
        var sb = new StringBuilder();
        for (var f : files) {
            var c = store.readNote(f);
            if (c != null && !c.isBlank()) sb.append("### ").append(f).append("\n").append(c).append("\n\n");
        }
        return Map.of("file", fileKey, "content", sb.toString().strip());
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static boolean safe(String filename) {
        return filename != null && !filename.isBlank()
                && !filename.contains("/") && !filename.contains("..")
                && !filename.startsWith(".");
    }
}
