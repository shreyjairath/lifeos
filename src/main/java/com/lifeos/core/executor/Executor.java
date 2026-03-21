package com.lifeos.core.executor;

import com.lifeos.core.executor.events.AgentAppendEvent;
import com.lifeos.core.executor.events.ExecutorEvent;
import com.lifeos.core.executor.events.ToolEvent;
import reactor.core.publisher.Flux;

import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The agentic loop: LLM → tools → LLM, until done or cancelled.
 * Yields typed events. Caller persists history via AgentAppendEvent.
 *
 * Each instance represents one run. Call cancel() to stop mid-stream.
 */
public class Executor {

    private final LlmClient llmClient;
    private final ToolsClient toolsClient;
    private final AtomicBoolean cancelled = new AtomicBoolean(false);

    public Executor(String apiKey, Confirmations confirmations) {
        this.llmClient = new LlmClient(apiKey);
        this.toolsClient = new ToolsClient(confirmations);
    }

    public void cancel() {
        cancelled.set(true);
    }

    /**
     * Run the agentic loop. Tools must always be supplied by the caller.
     */
    public Flux<ExecutorEvent> runLoop(
            List<Map<String, Object>> messages,
            String system,
            String model,
            List<Map<String, Object>> tools,
            String agentName,
            ToolInvoker dispatch
    ) {
        var local = new ArrayList<>(messages);

        return Flux.defer(() -> runOneIteration(local, system, model, tools, agentName, dispatch))
                .repeat()
                .takeUntil(event -> event instanceof LoopControl lc && lc.shouldStop())
                .filter(event -> !(event instanceof LoopControl));
    }


    // ── Private ──────────────────────────────────────────────────────────────────

    private Flux<ExecutorEvent> runOneIteration(
            List<Map<String, Object>> local,
            String system, String model,
            List<Map<String, Object>> tools,
            String agentName,
            ToolInvoker dispatch
    ) {
        if (cancelled.get()) {
            return Flux.just(LoopControl.STOP);
        }

        var llmResult = new LlmClient.LlmResult();

        return llmClient.stream(model, system, List.copyOf(local), tools, llmResult)
                .<ExecutorEvent>map(e -> e)
                .concatWith(Flux.defer(() -> afterLlm(local, llmResult, agentName, dispatch)));
    }

    @SuppressWarnings("unchecked")
    private Flux<ExecutorEvent> afterLlm(
            List<Map<String, Object>> local,
            LlmClient.LlmResult llmResult,
            String agentName,
            ToolInvoker dispatch
    ) {
        // Build assistant content
        var assistantContent = new ArrayList<Map<String, Object>>();
        if (!llmResult.getFullText().isEmpty()) {
            assistantContent.add(Map.of("type", "text", "text", llmResult.getFullText()));
        }
        for (var toolUse : llmResult.getParsedToolUses()) {
            assistantContent.add(Map.of(
                    "type", "tool_use",
                    "id", toolUse.get("id"),
                    "name", toolUse.get("name"),
                    "input", toolUse.get("input")
            ));
        }

        local.add(Map.of("role", "assistant", "content", assistantContent));
        prepareMessages(local);

        var appendEvent = new AgentAppendEvent("assistant", assistantContent);

        // If no tool use, we're done
        if (!"tool_use".equals(llmResult.getStopReason()) || llmResult.getParsedToolUses().isEmpty()) {
            return Flux.just(appendEvent, LoopControl.STOP);
        }

        // Dispatch tools
        var toolsResult = new ToolsClient.ToolsResult();
        return Flux.<ExecutorEvent>just(appendEvent)
                .concatWith(
                        toolsClient.invoke(llmResult.getParsedToolUses(), cancelled::get, toolsResult, agentName, dispatch)
                                .<ExecutorEvent>map(e -> e)
                                .doOnComplete(() -> {
                                    local.add(Map.of("role", "user", "content", toolsResult.getMessages()));
                                    prepareMessages(local);
                                })
                                .concatWith(Flux.defer(() -> {
                                    var toolAppend = new AgentAppendEvent("user", toolsResult.getMessages());
                                    if (toolsResult.isCancelled()) {
                                        return Flux.just(toolAppend, LoopControl.STOP);
                                    }
                                    return Flux.<ExecutorEvent>just(toolAppend);
                                }))
                );
    }

    /**
     * Trim leading orphaned tool_result blocks from history (mutates in place).
     */
    @SuppressWarnings("unchecked")
    public static void prepareMessages(List<Map<String, Object>> messages) {
        while (!messages.isEmpty()) {
            var content = messages.getFirst().get("content");
            if (content instanceof List<?> blocks) {
                boolean allToolResults = blocks.stream().allMatch(b ->
                        b instanceof Map<?, ?> m && "tool_result".equals(m.get("type")));
                if (allToolResults) {
                    messages.removeFirst();
                    continue;
                }
            }
            break;
        }
    }


    // ── Loop control sentinel ────────────────────────────────────────────────────

    private sealed interface LoopControl extends ExecutorEvent {
        boolean shouldStop();
        static final LoopControl STOP = new Stop();
    }

    private record Stop() implements LoopControl {
        public boolean shouldStop() { return true; }
    }
}
