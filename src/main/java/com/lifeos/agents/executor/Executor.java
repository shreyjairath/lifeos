package com.lifeos.agents.executor;

import com.lifeos.agents.executor.events.AgentAppendEvent;
import com.lifeos.agents.executor.events.ExecutorEvent;
import com.lifeos.agents.executor.events.ToolEvent;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;

import java.util.*;

/**
 * The agentic loop: LLM → tools → LLM, until done or cancelled.
 * Yields typed events. Caller persists history via AgentAppendEvent.
 */
@Component
public class Executor {

    private final LlmClient llmClient;
    private final ToolsClient toolsClient;
    private final ToolsRegistry toolsRegistry;
    private final Cancellation cancellation;

    public Executor(LlmClient llmClient, ToolsClient toolsClient,
                    ToolsRegistry toolsRegistry, Cancellation cancellation) {
        this.llmClient = llmClient;
        this.toolsClient = toolsClient;
        this.toolsRegistry = toolsRegistry;
        this.cancellation = cancellation;
    }

    public Flux<ExecutorEvent> runLoop(
            String sessionId,
            List<Map<String, Object>> messages,
            String system,
            String model
    ) {
        return runLoop(sessionId, messages, system, model, null);
    }

    /**
     * Run the agentic loop.
     */
    public Flux<ExecutorEvent> runLoop(
            String sessionId,
            List<Map<String, Object>> messages,
            String system,
            String model,
            List<Map<String, Object>> tools
    ) {
        var resolvedTools = tools != null ? tools : toolsRegistry.getTools();
        var local = new ArrayList<>(messages);

        return Flux.defer(() -> runOneIteration(sessionId, local, system, model, resolvedTools))
                .repeat()
                .takeUntil(event -> event instanceof LoopControl lc && lc.shouldStop())
                .filter(event -> !(event instanceof LoopControl));
    }


    // ── Private ──────────────────────────────────────────────────────────────────

    private Flux<ExecutorEvent> runOneIteration(
            String sessionId,
            List<Map<String, Object>> local,
            String system, String model,
            List<Map<String, Object>> tools
    ) {
        if (cancellation.isCancelled(sessionId)) {
            return Flux.just(LoopControl.STOP);
        }

        var llmResult = new LlmClient.LlmResult();

        // Stream LLM, then process result
        return llmClient.stream(model, system, List.copyOf(local), tools, llmResult)
                .<ExecutorEvent>map(e -> e)
                .concatWith(Flux.defer(() -> afterLlm(sessionId, local, llmResult)));
    }

    @SuppressWarnings("unchecked")
    private Flux<ExecutorEvent> afterLlm(
            String sessionId,
            List<Map<String, Object>> local,
            LlmClient.LlmResult llmResult
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
                        toolsClient.invoke(llmResult.getParsedToolUses(), sessionId, toolsResult)
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
