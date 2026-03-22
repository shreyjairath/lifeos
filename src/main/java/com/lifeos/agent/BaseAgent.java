package com.lifeos.agent;

import com.lifeos.config.AppConfig;
import com.lifeos.agentfleet.EventBus;
import com.lifeos.agent.PromptParts;
import com.lifeos.agent.PushNotifier;
import com.lifeos.agent.ChannelLog;
import com.lifeos.agent.AgentRunLogs;
import com.lifeos.agent.session.SessionHandler;
import com.lifeos.agent.executor.Confirmations;
import com.lifeos.agent.executor.Executor;
import com.lifeos.agent.executor.events.AgentAppendEvent;
import com.lifeos.agent.executor.events.ExecutorEvent;
import com.lifeos.agent.executor.events.LlmEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Common base for all agents.
 *
 * Subclasses implement:
 *   identity() — who the agent is; loaded in all modes
 *   tools()    — tools available in all modes (default: all from registry)
 *
 * All modes (chat, post-session, heartbeat, self-eval) run unconditionally for every agent.
 * Mode scaffolding (headers, footers, logging, push_to_user) is defined as constants here.
 */
public class BaseAgent implements Agent {

    private static final Logger log = LoggerFactory.getLogger(BaseAgent.class);
    private static final String DEFAULT_BACKGROUND_MODEL = "claude-haiku-4-5-20251001";

    /** Serializes all background runs (heartbeat, self-eval, post-session) for this agent. */
    private final ExecutorService backgroundExecutor = Executors.newSingleThreadExecutor(r -> {
        var t = new Thread(r);
        t.setDaemon(true);
        return t;
    });

    // ── Standard scaffolding (loaded from src/main/resources/prompt-parts/) ──────

    private static final String WORKSPACE_SETUP = PromptParts.load("workspace-setup.md");
    private static final String TEAM            = PromptParts.load("team.md");
    private static final String MODES           = PromptParts.load("modes.md");
    private static final String CHAT            = PromptParts.load("chat.md");
    private static final String POST_SESSION    = PromptParts.load("post-session.md");
    private static final String INTER_AGENT     = PromptParts.load("inter-agent-message.md");

    private final AgentDefinition def;
    private final ToolInvoker toolInvoker;
    private final ChannelLog agentChannels;
    protected final SessionHandler session;
    protected final EventBus eventBus;
    protected final AppConfig config;
    protected final PushNotifier webPush;
    protected final AgentRunLogs agentRunStore;

    private final Confirmations confirmations;
    private final ConcurrentHashMap<String, Executor> activeRuns = new ConcurrentHashMap<>();

    public BaseAgent(AgentDefinition def,
                     ToolInvoker toolInvoker,
                     ChannelLog agentChannels,
                     EventBus eventBus,
                     Confirmations confirmations,
                     AppConfig config,
                     PushNotifier webPush,
                     AgentRunLogs agentRunStore) {
        this.def = def;
        this.toolInvoker = toolInvoker;
        this.agentChannels = agentChannels;
        this.eventBus = eventBus;
        this.confirmations = confirmations;
        this.config = config;
        this.webPush = webPush;
        this.agentRunStore = agentRunStore;
        this.session = new SessionHandler(config, eventBus, def.name(),
                sessionId -> backgroundExecutor.submit(() -> handleSystemMessage("post-session", sessionId)));
        initListeners();
    }

    // ── Public ────────────────────────────────────────────────────────────────

    public SessionHandler getSessionHandler(){
        return this.session;
    }

    public void cancel(String sessionId) {
        var exec = activeRuns.get(sessionId);
        if (exec != null) exec.cancel();
    }

    private void initListeners() {
        session.initListeners();

        for (var bg : def.backgroundModes()) {
            eventBus.subscribe()
                    .filter(e -> bg.trigger().equals(e.get("type")))
                    .publishOn(Schedulers.boundedElastic())
                    .subscribe(
                            e -> backgroundExecutor.submit(() ->
                                    handleSystemMessage(bg.mode(), null)),
                            err -> log.warn("{} {} stream error: {}",
                                    agentName(), bg.trigger(), err.getMessage()));
        }
    }

    public Flux<ExecutorEvent> handleUserMessage(String sessionId, String userMessage) {
        log.info("{} chat starting — session {}", agentName(), sessionId);

        var prompt = buildSystemPrompt("chat", PromptOptions.forSession(sessionId));
        session.appendMessage(sessionId, Map.of("role", "user", "content", userMessage));

        var messages = session.getHistory(sessionId);
        Executor.prepareMessages(messages);

        // Buffer assistant+tool_use messages — only persist once the matching tool_result arrives.
        // If the stream is cancelled between the two, the orphaned tool_use is never written to disk.
        var pendingToolUse = new java.util.concurrent.atomic.AtomicReference<Map<String, Object>>();

        var runRecord = new AgentRunLogs.RunRecord(agentName(), "chat", prompt, config.model());
        eventBus.publish(Map.of("type", "agent_run_start", "agent", agentName(), "mode", "chat"));

        var resultAccum = new StringBuilder();

        var exec = newExecutor();
        activeRuns.put(sessionId, exec);

        return withLogging(exec.runLoop(messages, prompt, config.model(), tools(), agentName(), toolInvoker::invoke), runRecord)
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
                        // Accumulate ALL text from ALL assistant turns (including those with tool_use)
                        if ("assistant".equals(ae.role()) && ae.content() != null) {
                            ae.content().stream()
                                    .filter(b -> "text".equals(b.get("type")))
                                    .map(b -> (String) b.get("text"))
                                    .forEach(resultAccum::append);
                        }
                    } else if (event instanceof LlmEvent.Response resp) {
                        session.updateSessionMeta(sessionId, resp.usage().get("input_tokens"));
                    }
                })
                .doFinally(signal -> {
                    activeRuns.remove(sessionId);
                    runRecord.finish(resultAccum.toString());
                    agentRunStore.save(runRecord);
                    eventBus.publish(Map.of("type", "agent_run_end", "agent", agentName(), "mode", "chat",
                            "duration_ms", runRecord.durationMs, "result_preview", resultPreview(runRecord.result)));
                });
    }

    /**
     * Non-blocking variant — submits the incoming message to the background executor and returns
     * immediately. The reply will appear in the channel log once the run completes.
     */
    public void handleAgentMessageAsync(String fromAgent, String content) {
        backgroundExecutor.submit(() -> handleAgentMessage(fromAgent, content));
    }

    public String handleAgentMessage(String fromAgent, String content) {
        var channelLog = agentChannels.loadFull(agentName(), fromAgent);
        var prompt = buildSystemPrompt("inter-agent-message", PromptOptions.forChannel(fromAgent, channelLog));
        var messages = new ArrayList<Map<String, Object>>(List.of(
                Map.of("role", "user", "content", "[From: " + fromAgent + "]\n\n" + content)));
        Executor.prepareMessages(messages);

        var runRecord = new AgentRunLogs.RunRecord(agentName(), "inter-agent-message (from: " + fromAgent + ")", prompt, config.model());
        eventBus.publish(Map.of("type", "agent_run_start", "agent", agentName(), "mode", "inter-agent-message", "from", fromAgent));

        try {
            var result = extractText(withLogging(
                    newExecutor().runLoop(messages, prompt, config.model(), tools(), agentName(), toolInvoker),
                    runRecord)).block(java.time.Duration.ofSeconds(90));
            if (result == null) result = "";
            agentChannels.append(agentName(), fromAgent, content, result);
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

    private void handleSystemMessage(String mode, String closedSessionId) {
        if (!isModeEnabled(mode)) {
            log.debug("{} mode {} disabled, skipping", agentName(), mode);
            return;
        }
        log.info("{} {} starting", agentName(), mode);
        var systemPrompt = buildSystemPrompt(mode, PromptOptions.none());
        var userMsg = modePrompt(mode);
        if (closedSessionId != null && !closedSessionId.isBlank())
            userMsg += "\n\n# Closed Session ID\n\n" + closedSessionId;
        var messages = new ArrayList<Map<String, Object>>(List.of(Map.of("role", "user", "content", userMsg)));
        var runRecord = new AgentRunLogs.RunRecord(agentName(), mode, systemPrompt, backgroundModel());
        eventBus.publish(Map.of("type", "agent_run_start", "agent", agentName(), "mode", mode));

        try {
            var result = extractText(withLogging(
                    newExecutor().runLoop(messages, systemPrompt, backgroundModel(), tools(), agentName(), toolInvoker),
                    runRecord)).block();
            if (result == null) result = "";

            log.info("{} {} complete", agentName(), mode);

            runRecord.finish(result);
            agentRunStore.save(runRecord);
            eventBus.publish(Map.of("type", "agent_run_end", "agent", agentName(), "mode", mode,
                    "duration_ms", runRecord.durationMs, "result_preview", resultPreview(result)));

            var pushMessage = parsePushToUser(result);
            if (pushMessage != null && !pushMessage.isBlank()) {
                eventBus.publish(Map.of("type", "heartbeat", "agent", agentName(), "text", pushMessage));
                webPush.sendToAll("lifeos", pushMessage);
            }
        } catch (Exception e) {
            log.warn("{} {} failed: {}", agentName(), mode, e.getMessage());
            runRecord.finish("ERROR: " + e.getMessage());
            agentRunStore.save(runRecord);
            eventBus.publish(Map.of("type", "agent_run_end", "agent", agentName(), "mode", mode,
                    "duration_ms", runRecord.durationMs, "result_preview", "ERROR: " + e.getMessage()));
        }
    }

    // ── Agent interface ────────────────────────────────────────────────────────

    @Override public String getName()        { return def.name(); }
    @Override public String getTitle()       { return def.title(); }
    @Override public String getDescription() { return def.description(); }

    // ── Protected ─────────────────────────────────────────────────────────────

    protected String identity() {
        if (def.identity() == null || def.identity().isEmpty()) return "";
        return def.identity().stream()
                .map(f -> PromptParts.load(def.promptBase(), f))
                .collect(java.util.stream.Collectors.joining("\n\n"));
    }

    protected String agentName() { return def.name(); }

    protected boolean isModeEnabled(String mode) {
        return !def.disabledModes().contains(mode);
    }

    protected List<Map<String, Object>> tools() {
        return toolInvoker.definitions();
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private Executor newExecutor() {
        return new Executor(config.anthropicApiKey(), confirmations);
    }

    /** Wraps a flux with doOnNext to keep the RunRecord up to date. */
    private static Flux<ExecutorEvent> withLogging(Flux<ExecutorEvent> flux, AgentRunLogs.RunRecord record) {
        return flux.doOnNext(event -> {
            if (event instanceof LlmEvent.Request req) {
                record.setInitialMessages(req.messages());
                if (record.toolNames == null)
                    record.toolNames = req.tools().stream()
                            .map(t -> (String) t.get("name")).filter(java.util.Objects::nonNull).toList();
            } else if (event instanceof AgentAppendEvent ae) {
                record.addTurn(ae.role(), ae.content());
            } else if (event instanceof LlmEvent.Response resp) {
                record.addTokens(resp.usage().get("input_tokens"), resp.usage().get("output_tokens"));
            }
        });
    }

    /** Extracts concatenated assistant text from a stream. Caller decides whether/how to block. */
    private static Mono<String> extractText(Flux<ExecutorEvent> flux) {
        return flux
                .filter(e -> e instanceof AgentAppendEvent ae && "assistant".equals(ae.role()))
                .cast(AgentAppendEvent.class)
                .flatMapIterable(AgentAppendEvent::content)
                .filter(b -> b instanceof Map<?, ?> m && "text".equals(m.get("type")))
                .map(b -> (String) ((Map<?, ?>) b).get("text"))
                .reduce(String::concat)
                .defaultIfEmpty("");
    }

    private String backgroundModel() {
        var m = config.backgroundModel();
        return (m != null && !m.isBlank()) ? m : DEFAULT_BACKGROUND_MODEL;
    }

    private record PromptOptions(String sessionId, String fromAgent, String channelLog) {
        static PromptOptions none()                              { return new PromptOptions(null, null, null); }
        static PromptOptions forSession(String id)               { return new PromptOptions(id, null, null); }
        static PromptOptions forChannel(String from, String log) { return new PromptOptions(null, from, log); }
    }

    private String buildSystemPrompt(String mode, PromptOptions opts) {
        var p = identityWithName();
        var sb = new StringBuilder(p);
        sb.append("\n\n").append(WORKSPACE_SETUP).append("\n\n").append(TEAM);

        if ("chat".equals(mode) && opts.sessionId() != null) {
            session.getParentSummary(opts.sessionId()).ifPresent(s ->
                sb.append("\n\n# Session Context\n\n## Last Session — ")
                  .append(s.dateStr()).append("\n\n").append(s.content()));
        }

        sb.append("\n\n").append(modesSection(mode));

        if ("chat".equals(mode)) {
            sb.append("\n\n").append(CHAT);
        } else if ("inter-agent-message".equals(mode)) {
            var history = opts.channelLog() == null || opts.channelLog().isBlank()
                ? "No prior exchanges." : truncateTail(opts.channelLog(), 8_000);
            sb.append("\n\n").append(INTER_AGENT)
              .append("\n\n## Prior Exchanges with ").append(opts.fromAgent())
              .append("\n\n").append(history);
        }

        var now = ZonedDateTime.now().format(DateTimeFormatter.ofPattern("EEEE, MMMM d, yyyy h:mm a z"));
        sb.append("\n\n# Current Date & Time\n\n").append(now);

        return sb.toString().strip();
    }

    /** Returns the identity block prefixed with the agent's system name. */
    private String identityWithName() {
        var id = identity();
        var header = "Your name is **" + agentName() + "**.";
        return id.isBlank() ? header : header + "\n\n" + id;
    }

    private static boolean hasToolUse(List<Map<String, Object>> content) {
        return content != null && content.stream().anyMatch(b -> "tool_use".equals(b.get("type")));
    }

    private static String modesSection(String currentMode) {
        return MODES + "\n\n**Current mode: " + currentMode + "**";
    }

    private String modePrompt(String mode) {
        if ("post-session".equals(mode)) return POST_SESSION;
        return def.backgroundModes().stream()
                .filter(bg -> bg.mode().equals(mode))
                .findFirst()
                .map(bg -> PromptParts.load(def.promptBase(), bg.promptFile()))
                .orElseThrow(() -> new IllegalArgumentException("Unknown system mode: " + mode));
    }

    /** Returns the last {@code maxChars} characters of {@code s}, trimmed to a line boundary. */
    private static String truncateTail(String s, int maxChars) {
        if (s.length() <= maxChars) return s;
        var cut = s.substring(s.length() - maxChars);
        var nl = cut.indexOf('\n');
        return "[…]\n" + (nl >= 0 ? cut.substring(nl + 1) : cut);
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
