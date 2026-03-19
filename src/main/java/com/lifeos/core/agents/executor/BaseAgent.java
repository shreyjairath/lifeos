package com.lifeos.core.agents.executor;

import com.lifeos.config.AppConfig;
import com.lifeos.core.helpers.EventBus;
import com.lifeos.core.managers.SessionManager;
import com.lifeos.core.managers.WebPushService;
import com.lifeos.core.agents.tools.ToolsRegistry;
import com.lifeos.core.agents.store.AgentRunStore;
import com.lifeos.core.agents.executor.events.AgentAppendEvent;
import com.lifeos.core.agents.executor.events.ExecutorEvent;
import com.lifeos.core.agents.executor.events.LlmEvent;
import com.lifeos.core.agents.executor.events.ToolEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import reactor.core.publisher.Flux;
import reactor.core.scheduler.Schedulers;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Common base for user-facing agents.
 *
 * Subclasses implement:
 *   identity()          — who the agent is; used in all modes (chat, post-session, heartbeat, messaging)
 *   chatPrompt()        — chat-specific framing; used only in user-facing chat system prompt
 *   memory()            — optional knowledge section appended after identity+chatPrompt (default: empty)
 *   tools()             — tools for chat mode (default: all from registry)
 *   postSessionPrompt() — system prompt for post-session update (null = skip)
 *   postSessionTools()  — tools for post-session mode (default: all from registry)
 *   selfEvalPrompt()    — system prompt for scheduled self-evaluation (null = skip)
 *   selfEvalTools()     — tools for self-eval mode (default: postSessionTools())
 *   heartbeatPrompt()   — system prompt for scheduled heartbeat (null = skip)
 *   heartbeatTools()    — tools for heartbeat mode (default: postSessionTools())
 *
 * buildPrompt() appends the current timestamp to every system prompt.
 *
 * Each agent subscribes to `heartbeat_trigger` and `self_eval_trigger` events from the EventBus
 * and handles them independently — publishing results as `heartbeat` events and Web Push notifications.
 */
public abstract class BaseAgent {

    private static final Logger log = LoggerFactory.getLogger(BaseAgent.class);
    private static final String DEFAULT_REFLECT_MODEL = "claude-haiku-4-5-20251001";
    private static final Path CHANNELS_DIR = Path.of(".user-data/agents/inter-agent-channels");

    protected final Executor executor;
    protected final ToolsRegistry toolsRegistry;
    protected final SessionManager session;
    protected final EventBus eventBus;
    protected final Cancellation cancellation;
    protected final AppConfig config;
    protected final WebPushService webPush;
    protected final AgentRunStore agentRunStore;

    protected BaseAgent(Executor executor, ToolsRegistry toolsRegistry,
                        SessionManager session, EventBus eventBus,
                        Cancellation cancellation, AppConfig config,
                        WebPushService webPush, AgentRunStore agentRunStore) {
        this.executor = executor;
        this.toolsRegistry = toolsRegistry;
        this.session = session;
        this.eventBus = eventBus;
        this.cancellation = cancellation;
        this.config = config;
        this.webPush = webPush;
        this.agentRunStore = agentRunStore;
    }

    private String reflectModel() {
        var m = config.reflectModel();
        return (m != null && !m.isBlank()) ? m : DEFAULT_REFLECT_MODEL;
    }

    /** Called by AgentRegistry after construction — not a Spring bean so @PostConstruct won't fire. */
    public void initListeners() {
        if (heartbeatPrompt() != null) {
            eventBus.subscribe()
                    .filter(e -> "heartbeat_trigger".equals(e.get("type")))
                    .publishOn(Schedulers.boundedElastic())
                    .subscribe(
                            e -> runHeartbeat(),
                            err -> log.warn("{} heartbeat_trigger stream error: {}",
                                    getClass().getSimpleName(), err.getMessage()));
        }
        if (postSessionPrompt() != null) {
            eventBus.subscribe()
                    .filter(e -> "session_closed".equals(e.get("type"))
                            && agentName().equals(e.get("agent")))
                    .publishOn(Schedulers.boundedElastic())
                    .subscribe(
                            e -> {
                                var sessionId = (String) e.get("sessionId");
                                var transcript = SessionManager.buildTranscript(
                                        session.getHistory(sessionId));
                                postSession(transcript);
                            },
                            err -> log.warn("{} session_closed stream error: {}",
                                    getClass().getSimpleName(), err.getMessage()));
        }
        if (selfEvalPrompt() != null) {
            eventBus.subscribe()
                    .filter(e -> "self_eval_trigger".equals(e.get("type")))
                    .publishOn(Schedulers.boundedElastic())
                    .subscribe(
                            e -> runSelfEval(),
                            err -> log.warn("{} self_eval_trigger stream error: {}",
                                    getClass().getSimpleName(), err.getMessage()));
        }
    }

    public Flux<ExecutorEvent> chat(String sessionId, String userMessage) {
        log.info("{} chat starting — session {}", agentName(), sessionId);
        cancellation.clear(sessionId);

        var prompt = buildPrompt(sessionId);
        session.appendMessage(sessionId, Map.of("role", "user", "content", userMessage));

        var messages = session.getHistory(sessionId);
        Executor.prepareMessages(messages);

        // Buffer assistant+tool_use messages — only persist once the matching tool_result arrives.
        // If the stream is cancelled between the two, the orphaned tool_use is never written to disk.
        var pendingToolUse = new java.util.concurrent.atomic.AtomicReference<Map<String, Object>>();

        return executor.runLoop(sessionId, messages, prompt, config.model(), tools(), agentName())
                .doOnNext(event -> {
                    if (event instanceof AgentAppendEvent ae) {
                        var msg = Map.of("role", ae.role(), "content", ae.content());
                        if ("assistant".equals(ae.role()) && hasToolUse(ae.content())) {
                            pendingToolUse.set(msg);  // hold, don't save yet
                        } else {
                            var pending = pendingToolUse.getAndSet(null);
                            if (pending != null) session.appendMessage(sessionId, pending);
                            session.appendMessage(sessionId, msg);
                        }
                    } else if (event instanceof LlmEvent.Response resp) {
                        session.updateSessionMeta(sessionId, resp.usage().get("input_tokens"));
                    }
                });
    }

    private static boolean hasToolUse(List<Map<String, Object>> content) {
        return content != null && content.stream().anyMatch(b -> "tool_use".equals(b.get("type")));
    }

    /** Agent identity — used in all modes. */
    protected String identity() { return ""; }

    /** Chat-specific framing — injected only in user-facing chat system prompt. */
    protected String chatPrompt() { return ""; }

    protected abstract String agentName();

    protected String memory() { return ""; }

    protected List<Map<String, Object>> tools() {
        return toolsRegistry.getTools();
    }

    /**
     * Handles an incoming agent-to-agent message from another agent and returns the response.
     * Uses a shared append-only channel log per pair so both agents see the full exchange history.
     */
    public String message(String fromAgent, String content) {
        var channelLog = loadChannelLog(fromAgent);
        var prompt = buildMessageSystemPrompt(fromAgent, channelLog);
        var messages = new ArrayList<Map<String, Object>>(List.of(
                Map.of("role", "user", "content", "[From: " + fromAgent + "]\n\n" + content)));
        Executor.prepareMessages(messages);

        var runRecord = new AgentRunStore.RunRecord(agentName(), "inter-agent-message (from: " + fromAgent + ")", prompt);
        eventBus.publish(Map.of("type", "agent_run_start", "agent", agentName(), "mode", "inter-agent-message", "from", fromAgent));

        try {
            var response = executor.runLoop("_msg_" + agentName(), messages, prompt, config.model(), messageTools(), agentName())
                    .doOnNext(event -> {
                        if (event instanceof ToolEvent.Result tr)
                            runRecord.addToolCall(tr.name(), null, tr.result());
                    })
                    .filter(e -> e instanceof AgentAppendEvent ae && "assistant".equals(ae.role()))
                    .cast(AgentAppendEvent.class)
                    .flatMapIterable(AgentAppendEvent::content)
                    .filter(b -> b instanceof Map<?, ?> m && "text".equals(m.get("type")))
                    .map(b -> (String) ((Map<?, ?>) b).get("text"))
                    .reduce(String::concat)
                    .defaultIfEmpty("")
                    .block(java.time.Duration.ofSeconds(90));
            var result = response != null ? response : "";
            appendChannelLog(fromAgent, content, result);
            runRecord.finish(result);
            agentRunStore.save(runRecord);
            eventBus.publish(Map.of("type", "agent_run_end", "agent", agentName(), "mode", "inter-agent-message",
                    "from", fromAgent, "duration_ms", runRecord.durationMs, "result_preview", resultPreview(result)));
            return result;
        } catch (Exception e) {
            log.warn("{} message from {} failed: {}", agentName(), fromAgent, e.getMessage());
            runRecord.finish("ERROR: " + e.getMessage());
            agentRunStore.save(runRecord);
            eventBus.publish(Map.of("type", "agent_run_end", "agent", agentName(), "mode", "inter-agent-message",
                    "from", fromAgent, "duration_ms", runRecord.durationMs, "result_preview", "ERROR: " + e.getMessage()));
            return "Error: " + e.getMessage();
        }
    }

    /** Tools available during agent-to-agent messaging. Defaults to postSessionTools(). */
    protected List<Map<String, Object>> messageTools() { return postSessionTools(); }

    /** System prompt used during post-session update. Return null to skip for this agent. */
    protected String postSessionPrompt() { return null; }

    /** Tools available during post-session update. Defaults to all tools. */
    protected List<Map<String, Object>> postSessionTools() { return toolsRegistry.getTools(); }

    /** System prompt used during scheduled self-evaluation. Return null to skip for this agent. */
    protected String selfEvalPrompt() { return null; }

    /** Tools available during self-evaluation. Defaults to postSessionTools(). */
    protected List<Map<String, Object>> selfEvalTools() { return postSessionTools(); }

    /** System prompt used during heartbeat. Return null to skip heartbeat for this agent. */
    protected String heartbeatPrompt() { return null; }

    /** Tools available during heartbeat. Defaults to postSessionTools(). */
    protected List<Map<String, Object>> heartbeatTools() { return postSessionTools(); }

    /**
     * Runs the post-session update against the given transcript.
     * Returns a bullet summary of what was saved, or null if nothing / skipped.
     */
    public String postSession(String transcript) {
        var prompt = postSessionPrompt();
        if (prompt == null || prompt.isBlank() || transcript.isBlank()) return null;

        log.info("{} post-session starting", agentName());
        var messages = List.<Map<String, Object>>of(
                Map.of("role", "user", "content", "Session transcript to reflect on:\n\n" + transcript));

        var id = identity();
        prompt = (id.isBlank() ? "" : id + "\n\n") + prompt.strip() + "\n\n" + modesSection("post-session");

        var runRecord = new AgentRunStore.RunRecord(agentName(), "post-session", prompt);
        eventBus.publish(Map.of("type", "agent_run_start", "agent", agentName(), "mode", "post-session"));

        try {
            var summary = executor.runLoop("_postsession_" + getClass().getSimpleName(),
                            new ArrayList<>(messages), prompt, reflectModel(), postSessionTools(), agentName())
                    .doOnNext(event -> {
                        if (event instanceof ToolEvent.Result tr)
                            runRecord.addToolCall(tr.name(), null, tr.result());
                    })
                    .filter(e -> e instanceof AgentAppendEvent ae && "assistant".equals(ae.role()))
                    .cast(AgentAppendEvent.class)
                    .flatMapIterable(AgentAppendEvent::content)
                    .filter(b -> b instanceof Map<?, ?> m && "text".equals(m.get("type")))
                    .map(b -> (String) ((Map<?, ?>) b).get("text"))
                    .reduce(String::concat)
                    .defaultIfEmpty("")
                    .block();

            log.info("{} post-session complete — result: [{}]", agentName(),
                    summary != null ? summary.strip() : "null");

            runRecord.finish(summary);
            agentRunStore.save(runRecord);
            eventBus.publish(Map.of("type", "agent_run_end", "agent", agentName(), "mode", "post-session",
                    "duration_ms", runRecord.durationMs, "result_preview", resultPreview(summary)));

            if (summary != null && !summary.isBlank() && !"nothing to save".equalsIgnoreCase(summary.strip())) {
                return summary;
            }
        } catch (Exception e) {
            log.warn("{} post-session failed: {}", agentName(), e.getMessage());
        }
        return null;
    }

    protected String buildPrompt(String sessionId) {
        eventBus.publish(Map.of("type", "boot_start"));

        var id = identity();
        var cp = chatPrompt();
        var p = cp.isBlank() ? id : id + "\n\n" + cp;
        if (!p.isEmpty()) {
            eventBus.publish(Map.of("type", "knowledge_file", "file", "instructions",
                    "label", "Instructions", "status", "loaded", "chars", p.length()));
        }

        var k = memory();
        if (!k.isEmpty()) {
            eventBus.publish(Map.of("type", "knowledge_file", "file", "memory",
                    "label", "Memory", "status", "loaded", "chars", k.length()));
        }

        var system = k.isEmpty() ? p : p + "\n\n" + k;

        var parentSummary = session.getParentSummary(sessionId);
        if (parentSummary.isPresent()) {
            var s = parentSummary.get();
            eventBus.publish(Map.of("type", "knowledge_file", "file", "last_session",
                    "label", "Last Session", "status", "loaded", "chars", s.content().length()));
            system += "\n\n# Session Context\n\n## Last Session — " + s.dateStr() + "\n\n" + s.content();
        }

        var now = ZonedDateTime.now().format(DateTimeFormatter.ofPattern("EEEE, MMMM d, yyyy h:mm a z"));
        system = system.strip() + "\n\n" + modesSection("chat") + "\n\n# Current Date & Time\n\n" + now;
        eventBus.publish(Map.of("type", "system_prompt", "chars", system.length()));
        eventBus.publish(Map.of("type", "boot_done"));
        return system;
    }

    private String buildMessageSystemPrompt(String fromAgent, String channelLog) {
        var base = identity();
        var now = ZonedDateTime.now().format(DateTimeFormatter.ofPattern("EEEE, MMMM d, yyyy h:mm a z"));
        var history = channelLog.isBlank() ? "No prior exchanges." : channelLog;
        return base.strip()
                + "\n\n" + modesSection("inter-agent-message")
                + "\n\n# Internal Channel"
                + "\n\nThis is a private channel with other agents — not the user. "
                + "You received a message from " + fromAgent + ". Respond directly to them."
                + "\n\n## Prior Exchanges with " + fromAgent + "\n\n" + history
                + "\n\n# Current Date & Time\n\n" + now;
    }

    private String loadChannelLog(String partnerAgent) {
        var pair = agentName().compareTo(partnerAgent) < 0
                ? agentName() + "-" + partnerAgent
                : partnerAgent + "-" + agentName();
        var file = CHANNELS_DIR.resolve(pair + ".md");
        try {
            return Files.exists(file) ? Files.readString(file) : "";
        } catch (IOException e) {
            return "";
        }
    }

    private void appendChannelLog(String partnerAgent, String inbound, String response) {
        var pair = agentName().compareTo(partnerAgent) < 0
                ? agentName() + "-" + partnerAgent
                : partnerAgent + "-" + agentName();
        var file = CHANNELS_DIR.resolve(pair + ".md");
        var now = ZonedDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm z"));
        var entry = "## " + now + " | " + partnerAgent + " → " + agentName() + "\n"
                + inbound + "\n\n"
                + "**" + agentName() + " replied:**\n" + response + "\n\n---\n\n";
        try {
            Files.createDirectories(CHANNELS_DIR);
            Files.writeString(file, entry, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException e) {
            log.warn("Failed to append channel log {}: {}", file, e.getMessage());
        }
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private void runHeartbeat() {
        var prompt = heartbeatPrompt();
        if (prompt == null || prompt.isBlank()) return;

        log.info("{} heartbeat starting", agentName());
        var messages = List.<Map<String, Object>>of(
                Map.of("role", "user", "content", "Run your scheduled heartbeat check."));

        var id = identity();
        prompt = (id.isBlank() ? "" : id + "\n\n") + prompt.strip() + "\n\n" + modesSection("heartbeat");

        var runRecord = new AgentRunStore.RunRecord(agentName(), "heartbeat", prompt);
        eventBus.publish(Map.of("type", "agent_run_start", "agent", agentName(), "mode", "heartbeat"));

        try {
            var result = executor.runLoop("_heartbeat_" + getClass().getSimpleName(),
                            new ArrayList<>(messages), prompt, reflectModel(), heartbeatTools(), agentName())
                    .doOnNext(event -> {
                        if (event instanceof ToolEvent.Result tr)
                            runRecord.addToolCall(tr.name(), null, tr.result());
                    })
                    .filter(e -> e instanceof AgentAppendEvent ae && "assistant".equals(ae.role()))
                    .cast(AgentAppendEvent.class)
                    .flatMapIterable(AgentAppendEvent::content)
                    .filter(b -> b instanceof Map<?, ?> m && "text".equals(m.get("type")))
                    .map(b -> (String) ((Map<?, ?>) b).get("text"))
                    .reduce(String::concat)
                    .defaultIfEmpty("")
                    .block();

            log.info("{} heartbeat complete — result: [{}]", agentName(),
                    result != null ? result.strip() : "null");

            runRecord.finish(result);
            agentRunStore.save(runRecord);
            eventBus.publish(Map.of("type", "agent_run_end", "agent", agentName(), "mode", "heartbeat",
                    "duration_ms", runRecord.durationMs, "result_preview", resultPreview(result)));

            var pushMessage = parsePushToUser(result);
            if (pushMessage != null && !pushMessage.isBlank()) {
                var agentName = getClass().getSimpleName()
                        .replace("Agent", "").toLowerCase();
                eventBus.publish(Map.of("type", "heartbeat", "agent", agentName, "text", pushMessage));
                webPush.sendToAll("lifeos", pushMessage);
            }
        } catch (Exception e) {
            log.warn("{} heartbeat failed: {}", agentName(), e.getMessage());
            runRecord.finish("ERROR: " + e.getMessage());
            agentRunStore.save(runRecord);
            eventBus.publish(Map.of("type", "agent_run_end", "agent", agentName(), "mode", "heartbeat",
                    "duration_ms", runRecord.durationMs, "result_preview", "ERROR: " + e.getMessage()));
        }
    }

    private void runSelfEval() {
        var prompt = selfEvalPrompt();
        if (prompt == null || prompt.isBlank()) return;

        log.info("{} self-eval starting", agentName());
        var messages = List.<Map<String, Object>>of(
                Map.of("role", "user", "content", "Run your scheduled self-evaluation."));

        var id = identity();
        prompt = (id.isBlank() ? "" : id + "\n\n") + prompt.strip() + "\n\n" + modesSection("self-eval");

        var runRecord = new AgentRunStore.RunRecord(agentName(), "self-eval", prompt);
        eventBus.publish(Map.of("type", "agent_run_start", "agent", agentName(), "mode", "self-eval"));

        try {
            var result = executor.runLoop("_selfeval_" + getClass().getSimpleName(),
                            new ArrayList<>(messages), prompt, reflectModel(), selfEvalTools(), agentName())
                    .doOnNext(event -> {
                        if (event instanceof ToolEvent.Result tr)
                            runRecord.addToolCall(tr.name(), null, tr.result());
                    })
                    .filter(e -> e instanceof AgentAppendEvent ae && "assistant".equals(ae.role()))
                    .cast(AgentAppendEvent.class)
                    .flatMapIterable(AgentAppendEvent::content)
                    .filter(b -> b instanceof Map<?, ?> m && "text".equals(m.get("type")))
                    .map(b -> (String) ((Map<?, ?>) b).get("text"))
                    .reduce(String::concat)
                    .defaultIfEmpty("")
                    .block();

            log.info("{} self-eval complete — result: [{}]", agentName(),
                    result != null ? result.strip() : "null");

            runRecord.finish(result);
            agentRunStore.save(runRecord);
            eventBus.publish(Map.of("type", "agent_run_end", "agent", agentName(), "mode", "self-eval",
                    "duration_ms", runRecord.durationMs, "result_preview", resultPreview(result)));

            if (result != null && !result.isBlank() && !"nothing".equalsIgnoreCase(result.strip())) {
                var agentName = getClass().getSimpleName()
                        .replace("Agent", "").toLowerCase();
                eventBus.publish(Map.of("type", "heartbeat", "agent", agentName, "text", result.strip()));
                webPush.sendToAll("lifeos", result.strip());
            }
        } catch (Exception e) {
            log.warn("{} self-eval failed: {}", agentName(), e.getMessage());
            runRecord.finish("ERROR: " + e.getMessage());
            agentRunStore.save(runRecord);
            eventBus.publish(Map.of("type", "agent_run_end", "agent", agentName(), "mode", "self-eval",
                    "duration_ms", runRecord.durationMs, "result_preview", "ERROR: " + e.getMessage()));
        }
    }

    /**
     * Returns a modes section explaining all operating modes, with the current one marked active.
     * Injected into every system prompt so agents always know which mode they're in.
     */
    private static String modesSection(String currentMode) {
        return """
                # Operating Modes
                You run in one of five modes depending on context. The current mode is shown below.

                - **chat** — User is present and waiting for a response. Prioritize responsiveness. \
                Avoid `message_agent` unless information is immediately critical to answering the user right now; defer coordination to post-session.
                - **post-session** — Session just ended; user has left. No one is waiting. Good time for workspace updates, \
                cross-agent coordination, and `message_agent` calls.
                - **heartbeat** — Scheduled background check; no user present. Good time for proactive work and agent coordination.
                - **self-eval** — Scheduled self-evaluation; no user present. Assess quality and improve your operating approach.
                - **inter-agent-message** — Responding to another agent via internal channel. Be direct and concise; no user is involved.

                **Current mode: %s**""".formatted(currentMode);
    }

    private static String resultPreview(String result) {
        if (result == null || result.isBlank()) return "no output";
        var s = result.strip();
        return s.length() > 120 ? s.substring(0, 120) + "…" : s;
    }

    /** Extracts the quoted string from a trailing push_to_user:"..." line. Returns null if not found. */
    private static String parsePushToUser(String result) {
        if (result == null) return null;
        var lines = result.strip().lines().toList();
        for (int i = lines.size() - 1; i >= 0; i--) {
            var line = lines.get(i).strip();
            if (line.startsWith("push_to_user:")) {
                var rest = line.substring("push_to_user:".length()).strip();
                if (rest.startsWith("\"") && rest.endsWith("\"") && rest.length() >= 2) {
                    return rest.substring(1, rest.length() - 1).strip();
                }
                return null;
            }
        }
        return null;
    }
}
