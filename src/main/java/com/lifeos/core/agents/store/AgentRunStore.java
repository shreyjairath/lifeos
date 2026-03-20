package com.lifeos.core.agents.store;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.*;

/**
 * Persists system-captured agent run records to per-agent JSONL files.
 * Records are written by BaseAgent infrastructure — not by the agents themselves.
 *
 * Storage: .user-data/agents/{name}/_runs.jsonl (sibling to agent.yml, outside workspace/)
 */
@Component
public class AgentRunStore {

    private static final Logger log = LoggerFactory.getLogger(AgentRunStore.class);
    private static final Path AGENTS_DIR = Path.of(".user-data/agents");
    private static final int MAX_RESULT_CHARS = 50_000;
    private static final int MAX_PROMPT_CHARS = 20_000;
    private static final int MAX_TOOL_INPUT_CHARS = 500;
    private static final int MAX_TOOL_RESULT_CHARS = 300;

    private final ObjectMapper mapper = new ObjectMapper();

    /**
     * A run record built incrementally during execution, then saved on completion.
     */
    public static class RunRecord {
        public final String id = UUID.randomUUID().toString();
        public String agent;
        public String mode;
        public String model;
        public long startedAt;
        public long endedAt;
        public long durationMs;
        public int inputTokens;
        public int outputTokens;
        public String prompt;
        public final List<Map<String, Object>> toolCalls = new ArrayList<>();
        public String result;

        public RunRecord(String agent, String mode, String prompt, String model) {
            this.agent = agent;
            this.mode = mode;
            this.model = model;
            this.prompt = prompt != null && prompt.length() > MAX_PROMPT_CHARS
                    ? prompt.substring(0, MAX_PROMPT_CHARS) + "…"
                    : prompt;
            this.startedAt = System.currentTimeMillis();
        }

        public void addTokens(int input, int output) {
            this.inputTokens += input;
            this.outputTokens += output;
        }

        public void addToolCall(String name, Map<String, Object> input, Map<String, Object> result) {
            var entry = new LinkedHashMap<String, Object>();
            entry.put("name", name);
            entry.put("input", truncateValues(input, MAX_TOOL_INPUT_CHARS));
            if (result != null) {
                entry.put("result_preview", truncateToString(result, MAX_TOOL_RESULT_CHARS));
            }
            toolCalls.add(entry);
        }

        public void finish(String resultText) {
            this.endedAt = System.currentTimeMillis();
            this.durationMs = endedAt - startedAt;
            if (resultText != null && resultText.length() > MAX_RESULT_CHARS) {
                this.result = resultText.substring(0, MAX_RESULT_CHARS) + "…";
            } else {
                this.result = resultText;
            }
        }

        private static Map<String, Object> truncateValues(Map<String, Object> map, int maxLen) {
            if (map == null) return Map.of();
            var result = new LinkedHashMap<String, Object>();
            for (var entry : map.entrySet()) {
                var v = entry.getValue();
                if (v instanceof String s && s.length() > maxLen) {
                    result.put(entry.getKey(), s.substring(0, maxLen) + "…");
                } else {
                    result.put(entry.getKey(), v);
                }
            }
            return result;
        }

        private static String truncateToString(Object obj, int maxLen) {
            var s = obj.toString();
            return s.length() > maxLen ? s.substring(0, maxLen) + "…" : s;
        }
    }

    public void save(RunRecord record) {
        var agentDir = AGENTS_DIR.resolve(record.agent);
        if (!Files.isDirectory(agentDir)) {
            // Static agents (e.g. cos) may not have a .user-data/agents dir — skip
            return;
        }
        var file = agentDir.resolve("_runs.jsonl");
        try {
            var line = mapper.writeValueAsString(toMap(record)) + "\n";
            Files.writeString(file, line, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException e) {
            log.warn("Failed to save run record for agent {}: {}", record.agent, e.getMessage());
        }
    }

    /**
     * Returns the last {@code limit} records for the agent, newest first.
     */
    public List<Map<String, Object>> getRecentRuns(String agent, int limit) {
        var file = AGENTS_DIR.resolve(agent).resolve("_runs.jsonl");
        if (!Files.exists(file)) return List.of();
        try {
            var lines = Files.readAllLines(file);
            var result = new ArrayList<Map<String, Object>>();
            for (int i = lines.size() - 1; i >= 0 && result.size() < limit; i--) {
                var line = lines.get(i).trim();
                if (!line.isEmpty()) {
                    try {
                        @SuppressWarnings("unchecked")
                        var record = (Map<String, Object>) mapper.readValue(line, Map.class);
                        result.add(record);
                    } catch (Exception ignored) {}
                }
            }
            return result;
        } catch (IOException e) {
            log.warn("Failed to read run log for agent {}: {}", agent, e.getMessage());
            return List.of();
        }
    }

    // ── Private ──────────────────────────────────────────────────────────────

    private static Map<String, Object> toMap(RunRecord r) {
        var m = new LinkedHashMap<String, Object>();
        m.put("id", r.id);
        m.put("agent", r.agent);
        m.put("mode", r.mode);
        m.put("model", r.model);
        m.put("started_at", r.startedAt);
        m.put("ended_at", r.endedAt);
        m.put("duration_ms", r.durationMs);
        m.put("input_tokens", r.inputTokens);
        m.put("output_tokens", r.outputTokens);
        m.put("prompt", r.prompt);
        m.put("tool_calls", r.toolCalls);
        m.put("result", r.result);
        return m;
    }
}
