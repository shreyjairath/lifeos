import { LlmClient, newLlmResult } from './llm-client.js';
import { invokeTools, newToolsResult } from './tools-client.js';
import type { Confirmations } from './confirmations.js';
import type { ExecutorEvent, ToolInvoker } from '../types.js';

const MAX_TURNS = 100;

/**
 * The agentic loop: LLM → tools → LLM, until done or cancelled.
 *
 * Yields typed ExecutorEvents. Caller persists history via AgentAppendEvent.
 * Each instance represents one run; call cancel() to stop mid-stream.
 */
export class Executor {
  private readonly llmClient: LlmClient;
  private readonly confirmations: Confirmations;
  private _cancelled = false;

  constructor(apiKey: string, confirmations: Confirmations) {
    this.llmClient = new LlmClient(apiKey);
    this.confirmations = confirmations;
  }

  cancel(): void {
    this._cancelled = true;
  }

  async *runLoop(
    messages: Record<string, any>[],
    system: string,
    model: string,
    tools: Record<string, any>[],
    agentName: string,
    reasoning: Record<string, any> | null,
    dispatch: ToolInvoker,
  ): AsyncGenerator<ExecutorEvent> {
    // Work on a local copy so the caller's array isn't mutated mid-stream
    const local = [...messages];
    let turns = 0;

    while (true) {
      if (this._cancelled) return;
      if (turns >= MAX_TURNS) {
        console.warn(`[${agentName}] max turns (${MAX_TURNS}) reached — stopping`);
        yield { type: 'llm_text', text: `\n\n[Run stopped: max turns (${MAX_TURNS}) reached]` } as ExecutorEvent;
        return;
      }
      turns++;

      // ── LLM call ──────────────────────────────────────────────────────────
      const llmResult = newLlmResult();
      for await (const event of this.llmClient.stream(model, system, local, tools, reasoning, llmResult)) {
        yield event as ExecutorEvent;
      }

      // ── Build assistant message (OpenAI format) ───────────────────────────
      const assistantMsg: Record<string, any> = { role: 'assistant' };
      assistantMsg.content = llmResult.fullText || null;

      if (llmResult.parsedToolUses.length > 0) {
        assistantMsg.tool_calls = llmResult.parsedToolUses.map((tu) => ({
          id: tu.id,
          type: 'function',
          function: {
            name: tu.name,
            arguments: (() => {
              try {
                return JSON.stringify(tu.input);
              } catch {
                return '{}';
              }
            })(),
          },
        }));
      }

      if (llmResult.fullReasoning) {
        assistantMsg.reasoning = llmResult.fullReasoning;
      }

      local.push(assistantMsg);
      prepareMessages(local);
      yield { type: 'agent_append', role: 'assistant', message: assistantMsg };

      // ── No tool use — we're done ──────────────────────────────────────────
      if (llmResult.stopReason !== 'tool_use' || llmResult.parsedToolUses.length === 0) {
        return;
      }

      // ── Tool dispatch ─────────────────────────────────────────────────────
      const toolsResult = newToolsResult();
      for await (const event of invokeTools(
        llmResult.parsedToolUses,
        () => this._cancelled,
        toolsResult,
        agentName,
        dispatch,
        this.confirmations,
      )) {
        yield event;
      }

      // Append tool result messages to history
      for (const msg of toolsResult.messages) {
        local.push(msg);
        yield { type: 'agent_append', role: 'tool', message: msg };
      }
      prepareMessages(local);

      if (toolsResult.cancelled) return;
    }
  }
}

/**
 * Trim leading orphaned role:tool messages from history (mutates in place).
 * These can appear when a prior session's tail is prepended to a new one.
 */
export function prepareMessages(messages: Record<string, any>[]): void {
  while (messages.length > 0 && messages[0]!.role === 'tool') {
    messages.shift();
  }
}
