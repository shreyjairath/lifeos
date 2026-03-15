package com.lifeos.core.agents.tools;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.ZonedDateTime;
import java.util.*;

/**
 * File-backed reminder store. Reminders live in .user-data/system/reminders.json.
 * Each entry: { id, time (ISO-8601 epoch seconds as long), message }
 */
public class Reminders {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final Path file;

    public Reminders(Path mainDir) {
        this.file = mainDir.resolve("reminders.json");
    }

    public Map<String, Object> set(String isoTime, String message) {
        try {
            Instant time = ZonedDateTime.parse(isoTime).toInstant();
            var list = load();
            var entry = new LinkedHashMap<String, Object>();
            entry.put("id", UUID.randomUUID().toString().substring(0, 8));
            entry.put("time", time.getEpochSecond());
            entry.put("message", message);
            list.add(entry);
            save(list);
            return Map.of("ok", true, "id", entry.get("id"), "time", isoTime, "message", message);
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> list() {
        try {
            return Map.of("reminders", load());
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> delete(String id) {
        try {
            var list = load();
            boolean removed = list.removeIf(r -> id.equals(r.get("id")));
            if (!removed) return Map.of("error", "No reminder with id: " + id);
            save(list);
            return Map.of("ok", true);
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    /** Returns and removes all reminders whose time <= now. */
    public List<Map<String, Object>> pollDue() {
        try {
            var list = load();
            long now = Instant.now().getEpochSecond();
            var due = list.stream().filter(r -> ((Number) r.get("time")).longValue() <= now).toList();
            if (due.isEmpty()) return List.of();
            list.removeAll(due);
            save(list);
            return due;
        } catch (Exception e) {
            return List.of();
        }
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> load() throws IOException {
        if (!Files.exists(file)) return new ArrayList<>();
        var raw = MAPPER.readValue(Files.readString(file, StandardCharsets.UTF_8),
                new TypeReference<List<Map<String, Object>>>() {});
        return new ArrayList<>(raw);
    }

    private void save(List<Map<String, Object>> list) throws IOException {
        Files.writeString(file, MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(list),
                StandardCharsets.UTF_8);
    }
}
