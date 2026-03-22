package com.lifeos.agent;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Persists system-captured agent run records to per-agent JSONL files.
 * Records are written by BaseAgent infrastructure — not by the agents themselves.
 *
 * Storage: .user-data/agents/{name}/_runs.json (sibling to agent.yml, outside workspace/)
 */
@Component
public class AgentRunLogs {

    private static final Logger log = LoggerFactory.getLogger(AgentRunLogs.class);
    private static final Path AGENTS_DIR = Path.of(".user-data/agents");
    private static final int MAX_RESULT_CHARS = 50_000;
    private static final int MAX_PROMPT_CHARS = 20_000;
    private static final int MAX_TEXT_CHARS = 5_000;
    private static final int MAX_TOOL_INPUT_CHARS = 1_000;
    private static final int MAX_TOOL_RESULT_CHARS = 2_000;
    private static final int MAX_INITIAL_MESSAGES = 50;

    private final ObjectMapper mapper = new ObjectMapper();
    private final ConcurrentHashMap<String, ReentrantLock> fileLocks = new ConcurrentHashMap<>();

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
        public final List<Map<String, Object>> turns = new ArrayList<>();
        public List<Map<String, Object>> initialMessages;
        public List<String> toolNames;
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

        @SuppressWarnings("unchecked")
        public void addTurn(String role, List<Map<String, Object>> content) {
            if (content == null) return;
            var truncated = new ArrayList<Map<String, Object>>();
            for (var block : content) {
                var type = (String) block.get("type");
                if ("text".equals(type)) {
                    var text = (String) block.get("text");
                    truncated.add(Map.of("type", "text", "text", truncate(text, MAX_TEXT_CHARS)));
                } else if ("tool_use".equals(type)) {
                    var entry = new LinkedHashMap<>(block);
                    entry.put("input", truncateValues((Map<String, Object>) block.get("input"), MAX_TOOL_INPUT_CHARS));
                    truncated.add(entry);
                } else if ("tool_result".equals(type)) {
                    var entry = new LinkedHashMap<>(block);
                    var c = block.get("content");
                    entry.put("content", c instanceof String s ? truncate(s, MAX_TOOL_RESULT_CHARS) : c);
                    truncated.add(entry);
                } else {
                    truncated.add(block);
                }
            }
            turns.add(Map.of("role", role, "content", truncated));
        }

        /** Captures the initial messages list passed to the first LLM call. Idempotent — only set once. */
        @SuppressWarnings("unchecked")
        public void setInitialMessages(List<Map<String, Object>> messages) {
            if (this.initialMessages != null || messages == null) return;
            var capped = messages.size() > MAX_INITIAL_MESSAGES
                    ? messages.subList(messages.size() - MAX_INITIAL_MESSAGES, messages.size())
                    : messages;
            var result = new ArrayList<Map<String, Object>>();
            for (var msg : capped) {
                var role = msg.get("role");
                var content = msg.get("content");
                if (content instanceof String s) {
                    result.add(Map.of("role", role, "content", truncate(s, MAX_TEXT_CHARS)));
                } else if (content instanceof List<?> blocks) {
                    var truncatedBlocks = new ArrayList<Map<String, Object>>();
                    for (var raw : blocks) {
                        if (!(raw instanceof Map<?, ?> block)) continue;
                        var type = (String) block.get("type");
                        if ("text".equals(type)) {
                            truncatedBlocks.add(Map.of("type", "text", "text",
                                    truncate((String) block.get("text"), MAX_TEXT_CHARS)));
                        } else if ("tool_use".equals(type)) {
                            var entry = new LinkedHashMap<>((Map<String, Object>) block);
                            entry.put("input", truncateValues((Map<String, Object>) block.get("input"), MAX_TOOL_INPUT_CHARS));
                            truncatedBlocks.add(entry);
                        } else if ("tool_result".equals(type)) {
                            var entry = new LinkedHashMap<>((Map<String, Object>) block);
                            var c = block.get("content");
                            entry.put("content", c instanceof String str ? truncate(str, MAX_TOOL_RESULT_CHARS) : c);
                            truncatedBlocks.add(entry);
                        } else {
                            truncatedBlocks.add((Map<String, Object>) block);
                        }
                    }
                    result.add(Map.of("role", role, "content", truncatedBlocks));
                } else {
                    result.add((Map<String, Object>) msg);
                }
            }
            this.initialMessages = result;
        }

        private static String truncate(String s, int maxLen) {
            if (s == null) return "";
            return s.length() > maxLen ? s.substring(0, maxLen) + "…" : s;
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

    }

    public void save(RunRecord record) {
        var agentDir = AGENTS_DIR.resolve(record.agent);
        if (!Files.isDirectory(agentDir)) {
            // Static agents (e.g. cos) may not have a .user-data/agents dir — skip
            return;
        }
        var file = agentDir.resolve("_runs.json");
        var lock = fileLocks.computeIfAbsent(record.agent, k -> new ReentrantLock());
        lock.lock();
        try {
            Files.writeString(file, mapper.writeValueAsString(toMap(record)) + "\n",
                    StandardCharsets.UTF_8, StandardOpenOption.APPEND, StandardOpenOption.CREATE);
        } catch (IOException e) {
            log.warn("Failed to save run record for agent {}: {}", record.agent, e.getMessage());
        } finally {
            lock.unlock();
        }
    }

    /**
     * Returns the last {@code limit} records for the agent, newest first.
     */
    public List<Map<String, Object>> getRecentRuns(String agent, int limit) {
        var file = AGENTS_DIR.resolve(agent).resolve("_runs.json");
        if (!Files.exists(file)) return List.of();
        try {
            var lines = Files.readAllLines(file, StandardCharsets.UTF_8);
            var result = new ArrayList<Map<String, Object>>();
            for (int i = lines.size() - 1; i >= 0 && result.size() < limit; i--) {
                if (lines.get(i).isBlank()) continue;
                result.add(mapper.readValue(lines.get(i), new TypeReference<>() {}));
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
        m.put("tool_names", r.toolNames);
        m.put("turns", r.turns);
        m.put("initial_messages", r.initialMessages);
        m.put("result", r.result);
        return m;
    }
}
