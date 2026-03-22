package com.lifeos.agentfleet.tools;

import com.lifeos.agentfleet.ToolsRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardOpenOption;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Arrays;
import java.util.Map;

/**
 * Manages shared inter-agent channel logs.
 * Each pair of agents shares one append-only markdown file, keyed by sorted name pair.
 */
@Component
public class AgentChannels implements com.lifeos.agent.ChannelLog {

    private static final Logger log = LoggerFactory.getLogger(AgentChannels.class);
    private static final int MAX_ENTRIES = 100;

    /** Returns the full channel log content, or "" if none exists. */
    public String loadFull(String agentA, String agentB) {
        var file = channelFile(agentA, agentB);
        try {
            return Files.exists(file) ? Files.readString(file) : "";
        } catch (IOException e) {
            log.warn("Failed to read channel log {}: {}", file, e.getMessage());
            return "";
        }
    }

    /** Appends an exchange to the channel log and prunes to MAX_ENTRIES. */
    public void append(String agentA, String agentB, String inbound, String response) {
        var file = channelFile(agentA, agentB);
        var now = ZonedDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm z"));
        var entry = "## " + now + " | " + agentA + " → " + agentB + "\n"
                + inbound + "\n\n"
                + "**" + agentB + " replied:**\n" + response + "\n\n---\n\n";
        try {
            Files.createDirectories(file.getParent());
            Files.writeString(file, entry, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            prune(file);
        } catch (IOException e) {
            log.warn("Failed to append channel log {}: {}", file, e.getMessage());
        }
    }

    /** Tool handler for read_agent_channel — returns last 10 entries. */
    public Map<String, Object> readChannel(String callerAgent, String partnerAgent) {
        var raw = loadFull(callerAgent, partnerAgent);
        if (raw.isBlank()) return Map.of("log", "No prior exchanges.");
        var entries = raw.split("(?<=\n---\n\n)");
        var last10 = entries.length <= 10 ? raw
                : String.join("", Arrays.copyOfRange(entries, entries.length - 10, entries.length));
        return Map.of("log", last10);
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private static java.nio.file.Path channelFile(String agentA, String agentB) {
        var pair = agentA.compareTo(agentB) < 0 ? agentA + "-" + agentB : agentB + "-" + agentA;
        return ToolsRegistry.AGENTS_DIR.resolve("inter-agent-channels").resolve(pair + ".md");
    }

    private static void prune(java.nio.file.Path file) throws IOException {
        var raw = Files.readString(file);
        var entries = raw.split("(?<=\n---\n\n)", -1);
        if (entries.length > MAX_ENTRIES) {
            var trimmed = String.join("", Arrays.copyOfRange(entries, entries.length - MAX_ENTRIES, entries.length));
            Files.writeString(file, trimmed, StandardOpenOption.TRUNCATE_EXISTING);
        }
    }
}
