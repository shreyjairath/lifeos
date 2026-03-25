package com.lifeos.agent.executor;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.lifeos.agent.executor.events.AgentAppendEvent;
import com.lifeos.agent.executor.events.ExecutorEvent;
import com.lifeos.agent.executor.events.ToolEvent;
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
    private final ObjectMapper mapper = new ObjectMapper();

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
            Map<String, Object> reasoning,
            ToolInvoker dispatch
    ) {
        var local = new ArrayList<>(messages);

        return Flux.defer(() -> runOneIteration(local, system, model, tools, agentName, reasoning, dispatch))
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
            Map<String, Object> reasoning,
            ToolInvoker dispatch
    ) {
        if (cancelled.get()) {
            return Flux.just(LoopControl.STOP);
        }

        var llmResult = new LlmClient.LlmResult();

        return llmClient.stream(model, system, List.copyOf(local), tools, reasoning, llmResult)
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
        // Build assistant message in OpenAI format
        var assistantMsg = new LinkedHashMap<String, Object>();
        assistantMsg.put("role", "assistant");
        var toolUses = llmResult.getParsedToolUses();
        var rawText = llmResult.getFullText();
        assistantMsg.put("content", rawText.isEmpty() ? null : rawText);
        if (!toolUses.isEmpty()) {
            var toolCalls = toolUses.stream().map(tu -> {
                String arguments;
                try {
                    arguments = mapper.writeValueAsString(tu.get("input"));
                } catch (JsonProcessingException e) {
                    arguments = "{}";
                }
                return Map.of(
                        "id", tu.get("id"),
                        "type", "function",
                        "function", Map.of(
                                "name", tu.get("name"),
                                "arguments", arguments
                        )
                );
            }).toList();
            assistantMsg.put("tool_calls", toolCalls);
        }

        if (!llmResult.getFullReasoning().isEmpty()) {
            assistantMsg.put("reasoning", llmResult.getFullReasoning());
        }

        local.add(assistantMsg);
        prepareMessages(local);

        var appendEvent = new AgentAppendEvent(assistantMsg);

        // If no tool use, we're done
        if (!"tool_use".equals(llmResult.getStopReason()) || toolUses.isEmpty()) {
            return Flux.just(appendEvent, LoopControl.STOP);
        }

        // Dispatch tools
        var toolsResult = new ToolsClient.ToolsResult();
        return Flux.<ExecutorEvent>just(appendEvent)
                .concatWith(
                        toolsClient.invoke(toolUses, cancelled::get, toolsResult, agentName, dispatch)
                                .<ExecutorEvent>map(e -> e)
                                .doOnComplete(() -> {
                                    toolsResult.getMessages().forEach(local::add);
                                    prepareMessages(local);
                                })
                                .concatWith(Flux.defer(() -> {
                                    var toolMsgs = toolsResult.getMessages();
                                    var appendEvents = toolMsgs.stream()
                                            .<ExecutorEvent>map(AgentAppendEvent::new)
                                            .toList();
                                    if (toolsResult.isCancelled()) {
                                        return Flux.fromIterable(appendEvents)
                                                .concatWith(Flux.just(LoopControl.STOP));
                                    }
                                    return Flux.fromIterable(appendEvents);
                                }))
                );
    }

    /**
     * Trim leading orphaned role:tool messages from history (mutates in place).
     */
    public static void prepareMessages(List<Map<String, Object>> messages) {
        while (!messages.isEmpty() && "tool".equals(messages.getFirst().get("role"))) {
            messages.removeFirst();
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
