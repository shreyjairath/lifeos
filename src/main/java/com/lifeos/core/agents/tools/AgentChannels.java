package com.lifeos.core.agents.tools;

import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Map;

/**
 * Tool implementation for read_agent_channel.
 * Reads the shared inter-agent message log for a given agent pair.
 */
@Component
public class AgentChannels {

    public Map<String, Object> readChannel(String callerAgent, String partnerAgent) {
        var pair = callerAgent.compareTo(partnerAgent) < 0
                ? callerAgent + "-" + partnerAgent
                : partnerAgent + "-" + callerAgent;
        var file = ToolsRegistry.AGENTS_DIR.resolve("inter-agent-channels").resolve(pair + ".md");
        try {
            if (!Files.exists(file)) return Map.of("log", "No prior exchanges.");
            var raw = Files.readString(file);
            var entries = raw.split("(?<=\n---\n\n)");
            var last10 = entries.length <= 10 ? raw
                    : String.join("", Arrays.copyOfRange(entries, entries.length - 10, entries.length));
            return Map.of("log", last10);
        } catch (IOException e) {
            return Map.of("error", "Failed to read channel log: " + e.getMessage());
        }
    }
}
