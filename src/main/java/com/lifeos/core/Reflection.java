package com.lifeos.core;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.lifeos.executor.Executor;
import com.lifeos.executor.LlmClient;
import com.lifeos.executor.ToolsRegistry;
import com.lifeos.executor.events.AgentAppendEvent;
import com.lifeos.executor.events.LlmEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Instant;
import java.util.*;

/**
 * Session reflection: knowledge base update, session archive, conversation summary.
 * Runs only at session rotation, not after every turn.
 */
@Component
public class Reflection {

    private static final Logger log = LoggerFactory.getLogger(Reflection.class);
    private static final String HAIKU_MODEL = "claude-haiku-4-5-20251001";
    private static final Set<String> REFLECT_TOOL_NAMES = Set.of(
            "update_knowledge", "create_project", "update_project", "write_file", "update_file",
            "list_projects", "read_project",
            "add_project_file", "read_project_file", "update_project_file", "delete_project_file"
    );

    private static final String REFLECT_SYSTEM = """
            You are a memory agent. Review this conversation and persist any new, lasting information \
            to the user's knowledge base or projects using your tools.

            Persist:
            - New facts about the user (values, preferences, context) → update_knowledge("identity")
            - Routine or habit changes → update_knowledge("routines")
            - New services or tools mentioned → update_knowledge("services") or update_knowledge("tools")
            - Notes or documents the user wants saved → write_file / update_file

            Additionally, for every project touched in this session (or any active project whose state changed):
            1. Call list_projects to find relevant projects, then read_project to get current content.
            2. Rewrite the `snapshot` section with the current state of the project as of this session.
            3. Rewrite the `next_action` section with the clearest next step going forward.
            4. If the project's background or constraints changed, rewrite `context` too.
            These three sections are how continuity is maintained across sessions — always keep them current.

            Only persist information that is genuinely new or changed. Skip anything already known.
            After updating, respond with a short bullet list of what you saved. \
            If nothing was worth persisting, respond with exactly: nothing to save.""";

    private static final String SUMMARIZE_SYSTEM = """
            Summarize this conversation session in 2-3 concise paragraphs for archival purposes.
            Focus on: what was discussed, decisions made, open threads. Write in second person \
            ("You were discussing...", "The user asked..."). Be specific — include names, numbers, \
            and concrete details. Omit small talk.""";

    private static final String CONV_SUMMARIZE_SYSTEM = """
            You maintain a running summary of an ongoing conversation between a user and their personal AI agent.
            Given the current summary (if any) and a new session transcript, produce an updated summary that merges both.
            Capture: topics discussed, decisions made, actions taken, open threads, and key facts or preferences revealed.
            Write in second person ("You discussed...", "The user wants...").
            Be specific — include names, numbers, dates, concrete details.
            Aim for 3-6 paragraphs. Drop stale details that are no longer relevant. Omit small talk.""";

    private final Executor executor;
    private final LlmClient llmClient;
    private final ToolsRegistry toolsRegistry;
    private final Memory memory;
    private final Hooks hooks;

    public Reflection(Executor executor, LlmClient llmClient, ToolsRegistry toolsRegistry,
                      Memory memory, Hooks hooks) {
        this.executor = executor;
        this.llmClient = llmClient;
        this.toolsRegistry = toolsRegistry;
        this.memory = memory;
        this.hooks = hooks;
    }

    /**
     * Full 3-tier reflection at session rotation. Returns kb reflection summary if any.
     */
    public Mono<String> rotationReflect(
            String convId, List<Map<String, Object>> history,
            String pendingUserMessage, String sessionId
    ) {
        return Mono.fromCallable(() -> {
            var transcript = buildTranscript(history);
            if (transcript.isEmpty()) return null;

            if (pendingUserMessage != null && !pendingUserMessage.isEmpty()) {
                transcript += "\n\nUSER (pending — triggered session rotation): " + pendingUserMessage;
            }

            var summary = kbReflect(history, convId, sessionId);
            writeSessionSummary(convId, transcript);
            updateConvSummary(convId, transcript);
            hooks.fire("on_reflection_done", Map.of("conv_id", convId, "session_id", sessionId));
            return summary;
        }).subscribeOn(reactor.core.scheduler.Schedulers.boundedElastic());
    }


    // ── Private ──────────────────────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    private String buildTranscript(List<Map<String, Object>> history) {
        var lines = new ArrayList<String>();
        for (var msg : history) {
            var role = ((String) msg.getOrDefault("role", "")).toUpperCase();
            var content = msg.get("content");
            if (content instanceof String text) {
                lines.add(role + ": " + text);
            } else if (content instanceof List<?> blocks) {
                for (var block : blocks) {
                    if (!(block instanceof Map<?, ?> raw)) continue;
                    @SuppressWarnings("unchecked")
                    var b = (Map<String, Object>) raw;
                    var btype = (String) b.get("type");
                    if ("text".equals(btype)) {
                        lines.add(role + ": " + b.get("text"));
                    } else if ("tool_use".equals(btype)) {
                        try {
                            var input = new ObjectMapper().writeValueAsString(b.getOrDefault("input", Map.of()));
                            lines.add("TOOL CALL [" + b.get("name") + "]: " + input);
                        } catch (Exception ignored) {}
                    } else if ("tool_result".equals(btype)) {
                        lines.add("TOOL RESULT: " + b.getOrDefault("content", ""));
                    }
                }
            }
        }
        return String.join("\n\n", lines);
    }

    @SuppressWarnings("unchecked")
    private String kbReflect(List<Map<String, Object>> history, String convId, String sessionId) {
        var transcript = buildTranscript(history);
        if (transcript.isEmpty()) return null;

        var reflectTools = toolsRegistry.getTools().stream()
                .filter(t -> REFLECT_TOOL_NAMES.contains(t.get("name")))
                .toList();

        var messages = List.<Map<String, Object>>of(
                Map.of("role", "user", "content", "Conversation to reflect on:\n\n" + transcript));

        var summary = new String[]{""};

        executor.runLoop("_reflect", new ArrayList<>(messages), REFLECT_SYSTEM, HAIKU_MODEL, reflectTools)
                .doOnNext(event -> {
                    if (event instanceof AgentAppendEvent ae && "assistant".equals(ae.role())) {
                        var text = new StringBuilder();
                        for (var b : ae.content()) {
                            if (b instanceof Map<?, ?> m && "text".equals(m.get("type"))) {
                                text.append(m.get("text"));
                            }
                        }
                        summary[0] = text.toString();
                    }
                })
                .blockLast();

        if (!summary[0].isEmpty() && !"nothing to save".equalsIgnoreCase(summary[0].strip())) {
            hooks.fire("on_kb_reflect", Map.of("conv_id", convId, "session_id", sessionId, "summary", summary[0]));
            return summary[0];
        }
        return null;
    }

    private void writeSessionSummary(String convId, String transcript) {
        try {
            var result = new LlmClient.LlmResult();
            llmClient.stream(HAIKU_MODEL, SUMMARIZE_SYSTEM,
                    List.of(Map.<String, Object>of("role", "user", "content", transcript)),
                    List.of(), 1024, result
            ).blockLast();

            if (!result.getFullText().isEmpty()) {
                var sdir = memory.summariesDir(convId);
                Files.createDirectories(sdir);
                Files.writeString(sdir.resolve(Instant.now().getEpochSecond() + ".md"),
                        result.getFullText(), StandardCharsets.UTF_8);
            }
        } catch (Exception e) {
            log.warn("Session summary failed: {}", e.getMessage());
        }
    }

    private void updateConvSummary(String convId, String transcript) {
        try {
            var existing = memory.getConvSummary(convId);
            var userContent = "New session transcript:\n\n" + transcript;
            if (!existing.isEmpty()) {
                userContent = "Existing summary:\n\n" + existing + "\n\n---\n\n" + userContent;
            }
            var result = new LlmClient.LlmResult();
            llmClient.stream(HAIKU_MODEL, CONV_SUMMARIZE_SYSTEM,
                    List.of(Map.<String, Object>of("role", "user", "content", userContent)),
                    List.of(), 1024, result
            ).blockLast();

            if (!result.getFullText().isEmpty()) {
                memory.writeConvSummary(convId, result.getFullText());
            }
        } catch (Exception e) {
            log.warn("Conv summary failed: {}", e.getMessage());
        }
    }
}
