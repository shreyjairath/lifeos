package com.lifeos.core.agents.tools;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Arrays;
import java.util.Map;

/**
 * File-backed per-agent log store.
 * Appends structured entries to {workspace}/_log.md.
 */
public class AgentLog {

    private static final DateTimeFormatter HEADER_FMT =
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm 'UTC'").withZone(ZoneOffset.UTC);

    private final Path file;

    public AgentLog(Path workspace) {
        this.file = workspace.resolve("_log.md");
    }

    public Map<String, Object> append(String mode, String summary, String changed, String notes) {
        try {
            var now = Instant.now();
            var ts = HEADER_FMT.format(now);
            var iso = now.toString();

            var sb = new StringBuilder();
            sb.append("## ").append(ts).append(" — ").append(mode).append("\n\n");
            sb.append("**Summary:** ").append(summary.strip()).append("\n");
            if (changed != null && !changed.isBlank()) {
                sb.append("\n**Changed:**\n").append(changed.strip()).append("\n");
            }
            if (notes != null && !notes.isBlank()) {
                sb.append("\n**Notes:** ").append(notes.strip()).append("\n");
            }
            sb.append("\n---\n\n");

            Files.writeString(file, sb.toString(),
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            return Map.of("ok", true, "timestamp", iso);
        } catch (IOException e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> read(Integer lastN) {
        try {
            if (!Files.exists(file)) return Map.of("log", "");
            var content = Files.readString(file, StandardCharsets.UTF_8);
            if (lastN == null) return Map.of("log", content);
            // Entries are separated by "\n---\n"; take the last N
            var entries = content.split("\n---\n");
            var from = Math.max(0, entries.length - lastN);
            var recent = Arrays.copyOfRange(entries, from, entries.length);
            return Map.of("log", String.join("\n---\n", recent));
        } catch (IOException e) {
            return Map.of("error", e.getMessage());
        }
    }
}
