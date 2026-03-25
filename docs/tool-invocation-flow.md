# Tool Invocation Flow

This document traces the full path from an LLM tool-use decision to execution and back.

---

## Overview

```
LLM response (tool_calls)
  → Executor.afterLlm()
    → ToolsClient.invoke()
      → ToolInvoker.invoke()         ← per-tool dispatch
        → ToolsRegistry.dispatch()
          → tool implementation
      → tool result appended to local history
      → AgentAppendEvent emitted for each result
  → next Executor iteration (results sent to LLM)
```

---

## Step-by-step

### 1. LLM streams a tool-use response

`LlmClient.doStream()` reads the OpenRouter SSE stream. Tool calls arrive as incremental
`choices[0].delta.tool_calls` chunks, keyed by `index`. Each accumulates in a
`ToolUseAccumulator`:

```
index 0: id="call_abc", name="agent_bash", arguments (streamed in pieces)
index 1: id="call_def", name="web_search", arguments (streamed in pieces)
```

When `finish_reason: "tool_calls"` arrives, accumulated argument JSON is parsed and
`LlmEvent.ToolCall` is emitted for each tool. After the stream ends, `finalize()` sets
`result.parsedToolUses` — the authoritative list used for actual execution.

### 2. `afterLlm` builds the assistant message

`Executor.afterLlm()` runs after `llmClient.stream()` completes. It builds an
**OpenAI-format** assistant message:

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    { "id": "call_abc", "type": "function",
      "function": { "name": "agent_bash", "arguments": "{\"command\":\"ls\"}" } },
    { "id": "call_def", "type": "function",
      "function": { "name": "web_search", "arguments": "{\"query\":\"...\"}" } }
  ]
}
```

This message is added to `local` (the in-memory history for this agentic loop iteration)
and emitted as an `AgentAppendEvent` for the caller to persist.

### 3. `ToolsClient.invoke()` executes tools sequentially

```java
Flux.create(sink -> {
    toolExecutor.submit(() -> {
        for (var toolUse : toolUses) {
            invokeOne(toolUse, result, sink, agentName, dispatch);
        }
        sink.complete();
    });
});
```

- Runs on a **virtual thread** from `toolExecutor` (one per `Executor` instance).
- Tools are dispatched **sequentially**, not in parallel — even when the LLM requested multiple
  at once. (The LLM can request parallel calls; the executor runs them one after another.)
- Emits a `ToolEvent.Result` for each completed tool.

**Confirmation gating:** if a tool is in the `Confirmations` gate list, `invokeOne` pauses and
emits a `ToolEvent.ConfirmRequest`. The frontend must call `POST /api/tool-confirm/{requestId}`
before execution resumes. A denial returns `{error: "User denied execution of ..."}` as the
tool result.

### 4. Dispatch path

```
ToolsClient.invokeOne()
  → dispatch.invoke(name, input, agentName)          ← ToolInvoker (executor-layer interface)
    → agentfleet lambda created in AgentRegistry
      → ToolsRegistry.dispatch(name, input, agentName)
        → tool implementation (Bash, WebSearch, etc.)
```

The `ToolInvoker` interface in `executor` is minimal — just `invoke(name, input, agentName)`.
The full `agent.ToolInvoker` extends it with `definitions()` for the LLM schema. The anonymous
implementation in `AgentRegistry.loadAgent()` closes over the agent's filtered tool list and
delegates dispatch to `ToolsRegistry`.

### 5. Tool results are formatted and appended

Each result is serialized to JSON and stored as an **OpenAI-format tool message**:

```json
{ "role": "tool", "tool_call_id": "call_abc", "content": "{\"output\":\"...\",\"exit_code\":0}" }
```

On `doOnComplete`, all tool messages are added to `local` so the next LLM call includes them.
Each message is also emitted as an `AgentAppendEvent` for the caller to persist to disk.

### 6. Loop repeats

The loop in `Executor.runLoop()` uses `Flux.defer().repeat().takeUntil()`. When no `LoopControl.STOP`
is emitted in an iteration (i.e., tool use happened), `repeat()` fires and the next iteration begins —
sending the full updated history (including tool results) back to the LLM.

`LoopControl.STOP` is emitted only when:
- The LLM responds without tool use (`stop_reason != "tool_use"`)
- Cancellation is requested before or during tool execution

---

## Message history shape during a tool-use turn

```
Before iteration N:
  [user: "..."]

After LLM call + tool execution (iteration N local history):
  [user: "..."]
  [assistant: {content: null, tool_calls: [{id: "call_abc", ...}]}]
  [tool: {role: "tool", tool_call_id: "call_abc", content: "..."}]

Iteration N+1 sends all of the above to the LLM.
```

`Executor.prepareMessages()` trims any leading `role: "tool"` messages that would otherwise
make the history invalid (e.g., orphaned results from a cancelled prior run).

---

## Persistence: the pending-tool-use pattern

`BaseAgent.handleUserMessage()` holds the assistant tool-call message in memory until the
first tool result arrives, then flushes both atomically:

```java
if (isAssistantWithToolUse(msg)) {
    pendingToolUse.set(msg);          // don't write yet
} else {
    var pending = pendingToolUse.getAndSet(null);
    if (pending != null) session.appendMessage(sessionId, pending);  // flush assistant
    session.appendMessage(sessionId, msg);                           // then the result
}
```

This prevents a dangling `tool_calls` assistant message in storage if the stream is cancelled
between the assistant turn and the tool results.

---

## Inter-agent messaging and the response contract

`message_agent` dispatches via `AgentTools.messageAgent()` → `agent.handleAgentMessage()`.
The receiving agent's agentic loop runs to completion, and `extractText()` harvests the final
assistant text as the response.

**Critical rule:** in `inter-agent-message` mode, the receiving agent's **text output is the
response**. The framework routes it back automatically. Calling `message_agent` to "reply" is
wrong and creates a deadlock:

```
cos  blocks in ToolsClient waiting for dad.handleAgentMessage() to return
dad  blocks in ToolsClient waiting for cos.handleAgentMessage() to return
     → both time out after 90s
```

The `inter-agent-message.md` prompt explicitly prohibits this:
> Your text response is automatically routed back to the sender — do NOT call `message_agent`
> to reply.

Use tools to do work (read workspace, update state, research) — then write your reply as the
final text message. Do not use `message_agent` or `message_agent_async` to send the reply.
