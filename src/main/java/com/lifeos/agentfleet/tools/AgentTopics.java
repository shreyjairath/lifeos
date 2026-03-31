package com.lifeos.agentfleet.tools;

import com.lifeos.agentfleet.AgentRegistry;
import com.lifeos.agentfleet.ToolsRegistry;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Shared knowledge board — named topics where agents post messages and subscribers
 * read them at heartbeat time. Pull-based: publish is a cheap write; consumers poll.
 *
 * Storage:
 *   .user-data/topics/{topic}.md          — topic log, append-only, pruned to 100 entries
 *   .user-data/topics/.cursors/{agent}/{topic} — ISO-8601 timestamp; read_topic returns
 *                                                  only entries after this, then advances it
 */
@Component
public class AgentTopics {

    private static final Logger log = LoggerFactory.getLogger(AgentTopics.class);

    static final Path TOPICS_DIR = ToolsRegistry.AGENTS_DIR.getParent().resolve("topics");
    private static final Path CURSORS_DIR = TOPICS_DIR.resolve(".cursors");
    private static final int MAX_ENTRIES = 100;
    private static final int DEFAULT_FIRST_READ = 20;
    private static final DateTimeFormatter TS_FMT = DateTimeFormatter.ISO_OFFSET_DATE_TIME;
    private static final Pattern HEADER = Pattern.compile("^## (\\S+) \\| (.+)$");

    private final AgentRegistry agentRegistry;

    public AgentTopics(@Lazy AgentRegistry agentRegistry) {
        this.agentRegistry = agentRegistry;
    }

    @PostConstruct
    public void init() throws IOException {
        Files.createDirectories(TOPICS_DIR);
        Files.createDirectories(CURSORS_DIR);
    }

    // ── Public ────────────────────────────────────────────────────────────────────

    /**
     * Append a message to a topic log.
     * topic must match [a-z0-9_-]+.
     */
    public Map<String, Object> writeTopic(String fromAgent, String topic, String message) {
        if (topic == null || !topic.matches("[a-z0-9_-]+"))
            return Map.of("error", "topic must only contain lowercase letters, digits, underscores, or hyphens");
        if (message == null || message.isBlank())
            return Map.of("error", "message is required");

        var ts = ZonedDateTime.now(ZoneOffset.UTC).format(TS_FMT);
        var entry = "## " + ts + " | " + fromAgent + "\n\n" + message.strip() + "\n\n---\n\n";
        var file = TOPICS_DIR.resolve(topic + ".md");

        try {
            Files.writeString(file, entry, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            prune(file);
        } catch (IOException e) {
            log.warn("Failed to write to topic {}: {}", topic, e.getMessage());
            return Map.of("error", e.getMessage());
        }

        return Map.of("status", "written", "topic", topic);
    }

    /**
     * Read new messages on a topic since this agent's last read.
     * On first read: returns up to last 20 entries.
     * On subsequent reads: returns only entries published after the cursor.
     * Cursor is advanced to now on every call.
     */
    public Map<String, Object> readTopic(String agentName, String topic) {
        if (topic == null || topic.isBlank())
            return Map.of("error", "topic is required");

        var file = TOPICS_DIR.resolve(topic + ".md");
        if (!Files.exists(file))
            return Map.of("topic", topic, "messages", List.of(), "count", 0);

        try {
            var raw = Files.readString(file);
            var allEntries = Arrays.stream(raw.split("(?<=\n---\n\n)", -1))
                                   .filter(e -> !e.isBlank())
                                   .toList();

            var cursor = readCursor(agentName, topic);
            var firstRead = cursor.equals(Instant.EPOCH);
            writeCursor(agentName, topic, Instant.now());

            List<Map<String, Object>> messages = new ArrayList<>();
            if (firstRead) {
                var subset = allEntries.size() > DEFAULT_FIRST_READ
                        ? allEntries.subList(allEntries.size() - DEFAULT_FIRST_READ, allEntries.size())
                        : allEntries;
                for (var e : subset) {
                    var parsed = parseEntry(e);
                    if (parsed != null) messages.add(parsed);
                }
            } else {
                for (var e : allEntries) {
                    var parsed = parseEntryAfter(e, cursor);
                    if (parsed != null) messages.add(parsed);
                }
            }

            return Map.of("topic", topic, "messages", messages, "count", messages.size());
        } catch (IOException e) {
            log.warn("Failed to read topic {}: {}", topic, e.getMessage());
            return Map.of("error", e.getMessage());
        }
    }

    /**
     * List all topics that have been written to. All agents are considered subscribers
     * since every agent reads the knowledge board at heartbeat.
     */
    public Map<String, Object> listTopics(String callerAgent) {
        List<Map<String, Object>> topicList = new ArrayList<>();
        var allAgentNames = agentRegistry.all().stream().map(a -> a.getName()).toList();
        try {
            if (!Files.exists(TOPICS_DIR)) return Map.of("topics", topicList);
            try (var stream = Files.list(TOPICS_DIR)) {
                stream.filter(p -> p.getFileName().toString().endsWith(".md"))
                      .sorted()
                      .forEach(p -> {
                          var name = p.getFileName().toString().replace(".md", "");
                          var subscribers = allAgentNames;
                          var entry = new LinkedHashMap<String, Object>();
                          entry.put("name", name);
                          entry.put("subscribers", subscribers);
                          topicList.add(entry);
                      });
            }
        } catch (IOException e) {
            log.warn("Failed to list topics: {}", e.getMessage());
        }
        return Map.of("topics", topicList);
    }

    // ── Private ───────────────────────────────────────────────────────────────────

    /** Parse entry, always include it. Returns null if entry is malformed. */
    private Map<String, Object> parseEntry(String entry) {
        return parseEntryAfter(entry, null);
    }

    /** Parse entry, include only if timestamp is after cursor (or cursor is null = always include). */
    private Map<String, Object> parseEntryAfter(String entry, Instant cursor) {
        var lines = entry.strip().split("\n", 3);
        if (lines.length < 1) return null;
        var m = HEADER.matcher(lines[0].strip());
        if (!m.matches()) return null;

        try {
            var ts = Instant.from(TS_FMT.parse(m.group(1)));
            if (cursor != null && !ts.isAfter(cursor)) return null;

            var content = lines.length >= 3 ? lines[2].strip() : "";
            var result = new LinkedHashMap<String, Object>();
            result.put("timestamp", m.group(1));
            result.put("from", m.group(2));
            result.put("message", content);
            return result;
        } catch (Exception e) {
            return null;
        }
    }

    private Instant readCursor(String agentName, String topic) {
        var cursorFile = CURSORS_DIR.resolve(agentName).resolve(topic);
        try {
            if (Files.exists(cursorFile))
                return Instant.parse(Files.readString(cursorFile).strip());
        } catch (Exception ignored) {}
        return Instant.EPOCH;
    }

    private void writeCursor(String agentName, String topic, Instant ts) {
        var cursorFile = CURSORS_DIR.resolve(agentName).resolve(topic);
        try {
            Files.createDirectories(cursorFile.getParent());
            Files.writeString(cursorFile, ts.toString(),
                    StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
        } catch (IOException e) {
            log.warn("Failed to write cursor {}/{}: {}", agentName, topic, e.getMessage());
        }
    }

    private static void prune(Path file) throws IOException {
        var raw = Files.readString(file);
        var entries = raw.split("(?<=\n---\n\n)", -1);
        if (entries.length > MAX_ENTRIES) {
            var trimmed = String.join("",
                    Arrays.copyOfRange(entries, entries.length - MAX_ENTRIES, entries.length));
            Files.writeString(file, trimmed, StandardOpenOption.TRUNCATE_EXISTING);
        }
    }
}
