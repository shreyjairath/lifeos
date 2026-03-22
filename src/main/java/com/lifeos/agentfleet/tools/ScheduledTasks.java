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
 * File-backed per-agent scheduled task store.
 * Tasks live at {workspace}/_tasks.json.
 *
 * Recurring task: cadence_hours set, run_at null.
 *   Overdue when: never run, or last_run + cadence_hours * 3600 <= now.
 *
 * One-off task: run_at set (epoch seconds), cadence_hours null.
 *   Overdue when: run_at <= now and last_run is null.
 *   Done once mark_task_complete is called — never overdue again.
 */
public class ScheduledTasks {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final DateTimeFormatter ISO = DateTimeFormatter.ISO_OFFSET_DATE_TIME;

    private final Path file;

    public ScheduledTasks(Path workspace) {
        this.file = workspace.resolve("_tasks.json");
    }

    public Map<String, Object> schedule(String name, String description,
                                         Double cadenceHours, String runAtIso) {
        if (cadenceHours == null && runAtIso == null)
            return Map.of("error", "One of cadence_hours or run_at is required.");
        if (cadenceHours != null && runAtIso != null)
            return Map.of("error", "Provide cadence_hours or run_at, not both.");
        try {
            Long runAtEpoch = null;
            if (runAtIso != null) {
                runAtEpoch = ZonedDateTime.parse(runAtIso).toInstant().getEpochSecond();
            }
            var list = load();
            // upsert by name
            var existing = list.stream().filter(t -> name.equals(t.get("name"))).findFirst();
            Map<String, Object> task;
            if (existing.isPresent()) {
                task = existing.get();
            } else {
                task = new LinkedHashMap<>();
                task.put("id", UUID.randomUUID().toString().substring(0, 8));
                task.put("created_at", Instant.now().getEpochSecond());
                task.put("last_run", null);
                list.add(task);
            }
            task.put("name", name);
            task.put("description", description);
            task.put("cadence_hours", cadenceHours);
            task.put("run_at", runAtEpoch);
            save(list);
            return Map.of("ok", true, "id", task.get("id"), "name", name,
                    "next_due", nextDueIso(task));
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> list() {
        try {
            var tasks = load().stream().map(this::withNextDue).toList();
            return Map.of("tasks", tasks);
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> getOverdue() {
        try {
            long now = Instant.now().getEpochSecond();
            var overdue = load().stream()
                    .filter(t -> isOverdue(t, now))
                    .map(this::withNextDue)
                    .toList();
            return Map.of("tasks", overdue);
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> markComplete(String id) {
        try {
            var list = load();
            var task = list.stream().filter(t -> id.equals(t.get("id"))).findFirst()
                    .orElse(null);
            if (task == null) return Map.of("error", "No task with id: " + id);
            task.put("last_run", Instant.now().getEpochSecond());
            save(list);
            return Map.of("ok", true, "id", id, "next_due", nextDueIso(task));
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private boolean isOverdue(Map<String, Object> task, long now) {
        var lastRun = task.get("last_run");
        var cadenceHours = task.get("cadence_hours");
        var runAt = task.get("run_at");

        if (cadenceHours != null) {
            // recurring: overdue if never run, or last_run + cadence <= now
            if (lastRun == null) return true;
            double hours = ((Number) cadenceHours).doubleValue();
            long lastRunEpoch = ((Number) lastRun).longValue();
            return lastRunEpoch + (long) (hours * 3600) <= now;
        } else if (runAt != null) {
            // one-off: overdue if not yet completed and run_at <= now
            if (lastRun != null) return false;
            return ((Number) runAt).longValue() <= now;
        }
        return false;
    }

    private String nextDueIso(Map<String, Object> task) {
        var cadenceHours = task.get("cadence_hours");
        var runAt = task.get("run_at");
        var lastRun = task.get("last_run");

        if (cadenceHours != null) {
            double hours = ((Number) cadenceHours).doubleValue();
            long base = lastRun != null ? ((Number) lastRun).longValue() : Instant.now().getEpochSecond();
            return Instant.ofEpochSecond(base + (long) (hours * 3600))
                    .atZone(ZoneOffset.UTC).format(ISO);
        } else if (runAt != null) {
            return Instant.ofEpochSecond(((Number) runAt).longValue())
                    .atZone(ZoneOffset.UTC).format(ISO);
        }
        return "unknown";
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
        Files.writeString(file, MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(list),
                StandardCharsets.UTF_8);
    }
}
