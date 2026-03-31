import type { Confirmations } from './confirmations.js';
import type { ParsedToolUse } from './llm-client.js';
import type { ExecutorEvent, ToolInvoker } from '../types.js';

export interface ToolsResult {
  messages: Record<string, any>[];
  cancelled: boolean;
}

export function newToolsResult(): ToolsResult {
  return { messages: [], cancelled: false };
}

/**
 * Sequential async tool dispatch with gating and cancellation.
 * Yields typed ExecutorEvents for each tool invocation.
 */
export async function* invokeTools(
  toolUses: ParsedToolUse[],
  isCancelled: () => boolean,
  result: ToolsResult,
  agentName: string,
  dispatch: ToolInvoker,
  confirmations: Confirmations,
): AsyncGenerator<ExecutorEvent> {
  for (let i = 0; i < toolUses.length; i++) {
    if (isCancelled()) {
      stubTools(toolUses.slice(i), result, 'Cancelled by user');
      result.cancelled = true;
      yield { type: 'tool_cancelled' };
      return;
    }

    yield* invokeOne(toolUses[i]!, result, agentName, dispatch, confirmations);
  }
}

// ── Private ───────────────────────────────────────────────────────────────────

async function* invokeOne(
  toolUse: ParsedToolUse,
  result: ToolsResult,
  agentName: string,
  dispatch: ToolInvoker,
  confirmations: Confirmations,
): AsyncGenerator<ExecutorEvent> {
  const { id, name, input } = toolUse;

  if (confirmations.isGated(name)) {
    const { requestId, promise } = confirmations.register();
    yield { type: 'tool_confirm_request', requestId, name, input };
    const approved = await promise;
    if (!approved) {
      const toolResult = { error: `User denied execution of ${name}` };
      yield { type: 'tool_confirm_denied', name };
      appendResult(id, toolResult, result);
      return;
    }
  }

  let toolResult: Record<string, any>;
  try {
    toolResult = await Promise.resolve(dispatch.invoke(name, input, agentName));
  } catch (err: any) {
    toolResult = { error: err?.message ?? 'Tool invocation failed' };
  }

  appendResult(id, toolResult, result);
  yield { type: 'tool_result', name, result: toolResult };
}

function appendResult(
  toolUseId: string,
  toolResult: Record<string, any>,
  result: ToolsResult,
): void {
  let content: string;
  try {
    content = JSON.stringify(toolResult);
  } catch {
    content = '{"error":"Failed to serialize tool result"}';
  }
  result.messages.push({
    role: 'tool',
    tool_call_id: toolUseId,
    content,
  });
}

function stubTools(
  toolUses: ParsedToolUse[],
  result: ToolsResult,
  error: string,
): void {
  for (const toolUse of toolUses) {
    result.messages.push({
      role: 'tool',
      tool_call_id: toolUse.id,
      content: JSON.stringify({ error }),
    });
  }
}
