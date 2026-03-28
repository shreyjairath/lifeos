package com.lifeos.agentfleet.tools;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;

/**
 * Shared task board backed by a single file (.user-data/tasks.json).
 * All agents share one board; tasks carry created_by and assignee fields.
 *
 * due_at is always required — the initial due date (epoch seconds).
 *
 * One-off task: cadence_hours null.
 *   Overdue when: due_at <= now and last_run is null.
 *   Done once mark_task_complete is called — never overdue again.
 *
 * Recurring task: cadence_hours set.
 *   Overdue when: (last_run == null && due_at <= now) OR (last_run + cadence_hours * 3600 <= now).
 *   After mark_task_complete: next due = last_run + cadence_hours * 3600.
 */
public class ScheduledTasks {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final DateTimeFormatter ISO = DateTimeFormatter.ISO_OFFSET_DATE_TIME;

    private final Path file;

    public ScheduledTasks(Path file) {
        this.file = file;
    }

    public Map<String, Object> upsert(String createdBy, String name, String description,
                                      Double cadenceHours, String dueAtIso, String assignee) {
        if (dueAtIso == null)
            return Map.of("error", "due_at is required.");
        try {
            long dueAtEpoch = ZonedDateTime.parse(dueAtIso).toInstant().getEpochSecond();
            var list = load();
            // upsert by (created_by, name) — each agent has their own namespace
            var existing = list.stream()
                    .filter(t -> createdBy.equals(t.get("created_by")) && name.equals(t.get("name")))
                    .findFirst();
            Map<String, Object> task;
            if (existing.isPresent()) {
                task = existing.get();
            } else {
                task = new LinkedHashMap<>();
                task.put("id", UUID.randomUUID().toString().substring(0, 8));
                task.put("created_by", createdBy);
                task.put("created_at", Instant.now().getEpochSecond());
                task.put("last_run", null);
                list.add(task);
            }
            task.put("name", name);
            task.put("description", description);
            task.put("cadence_hours", cadenceHours);
            task.put("due_at", dueAtEpoch);
            task.put("assignee", (assignee != null && !assignee.isBlank()) ? assignee : createdBy);
            task.put("last_modified_at", Instant.now().getEpochSecond());
            task.put("last_modified_by", createdBy);
            save(list);
            return Map.of("ok", true, "id", task.get("id"), "name", name,
                    "created_by", createdBy, "next_due", nextDueIso(task));
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> list(String assigneeFilter) {
        try {
            var tasks = load().stream()
                    .filter(t -> assigneeFilter == null || assigneeFilter.equals(t.get("assignee")))
                    .map(this::withNextDue)
                    .toList();
            return Map.of("tasks", tasks);
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> getOverdue(String assigneeFilter) {
        try {
            long now = Instant.now().getEpochSecond();
            var overdue = load().stream()
                    .filter(t -> assigneeFilter == null || assigneeFilter.equals(t.get("assignee")))
                    .filter(t -> isOverdue(t, now))
                    .map(this::withNextDue)
                    .toList();
            return Map.of("tasks", overdue);
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> markComplete(String id, String calledBy) {
        try {
            var list = load();
            var task = list.stream().filter(t -> id.equals(t.get("id"))).findFirst()
                    .orElse(null);
            if (task == null) return Map.of("error", "No task with id: " + id);
            long now = Instant.now().getEpochSecond();
            task.put("last_run", now);
            task.put("last_modified_at", now);
            task.put("last_modified_by", calledBy);
            save(list);
            return Map.of("ok", true, "id", id, "next_due", nextDueIso(task));
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> delete(String id) {
        try {
            var list = load();
            var before = list.size();
            list.removeIf(t -> id.equals(t.get("id")));
            if (list.size() == before)
                return Map.of("error", "No task with id: " + id);
            save(list);
            return Map.of("ok", true, "id", id);
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private boolean isOverdue(Map<String, Object> task, long now) {
        var lastRun = task.get("last_run");
        var cadenceHours = task.get("cadence_hours");
        var dueAt = task.getOrDefault("due_at", task.get("run_at"));
        if (dueAt == null) return false;

        if (lastRun == null) {
            // never run: overdue if due_at has passed
            return ((Number) dueAt).longValue() <= now;
        }
        if (cadenceHours == null) {
            // one-off and already run: done
            return false;
        }
        // recurring: overdue if last_run + cadence has passed
        double hours = ((Number) cadenceHours).doubleValue();
        return ((Number) lastRun).longValue() + (long) (hours * 3600) <= now;
    }

    private String nextDueIso(Map<String, Object> task) {
        var cadenceHours = task.get("cadence_hours");
        var dueAt = task.getOrDefault("due_at", task.get("run_at"));
        var lastRun = task.get("last_run");

        if (lastRun == null) {
            // never run: next due is due_at
            if (dueAt == null) return "unknown";
            return Instant.ofEpochSecond(((Number) dueAt).longValue())
                    .atZone(ZoneOffset.UTC).format(ISO);
        }
        if (cadenceHours == null) return "completed";
        // recurring: next due is last_run + cadence
        double hours = ((Number) cadenceHours).doubleValue();
        return Instant.ofEpochSecond(((Number) lastRun).longValue() + (long) (hours * 3600))
                .atZone(ZoneOffset.UTC).format(ISO);
    }

    private Map<String, Object> withNextDue(Map<String, Object> task) {
        var copy = new LinkedHashMap<>(task);
        copy.put("next_due", nextDueIso(task));
        return copy;
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> load() throws IOException {
        if (!Files.exists(file)) return new ArrayList<>();
        var raw = MAPPER.readValue(Files.readString(file, StandardCharsets.UTF_8),
                new TypeReference<List<Map<String, Object>>>() {});
        return new ArrayList<>(raw);
    }

    private void save(List<Map<String, Object>> list) throws IOException {
        Files.createDirectories(file.getParent());
        Files.writeString(file, MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(list),
                StandardCharsets.UTF_8);
    }
}
