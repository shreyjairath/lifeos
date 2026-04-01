import type { AgentRegistry } from './agent-registry.js';
import type { EventBus } from './event-bus.js';
import type { ExecutorEvent } from '../agent/types.js';

/**
 * Serialized SSE event from an agent run.
 * The data field is a JSON string — the frontend parses it.
 */
export interface SseFrame {
  data: string;
  event?: string;
}

/**
 * Orchestrates an incoming message:
 *   1. Rotation check
 *   2. Agent run (async generator)
 *   3. SSE serialization
 */
export class AgentRouter {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly eventBus: EventBus,
  ) {}

  async *handleMessage(
    sessionId: string | undefined,
    message: string,
    agentName: string,
    model?: string,
  ): AsyncGenerator<SseFrame> {
    try {
      yield* this.handleInner(sessionId, message, agentName, model);
    } catch (err: any) {
      const text = err?.message ?? 'Unknown error';
      this.eventBus.publish({ type: 'error', text });
      yield sse({ type: 'error', text });
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private async *handleInner(
    sessionId: string | undefined,
    message: string,
    agentName: string,
    model?: string,
  ): AsyncGenerator<SseFrame> {
    const agent = this.registry.get(agentName);

    // Auto-create session if not provided
    if (!sessionId) {
      sessionId = agent.getSessionHandler().createNew(agentName);
      yield sse({ type: 'session_id', session_id: sessionId });
    }

    const rotation = agent.getSessionHandler().checkRotation(sessionId);

    let activeSessionId = sessionId;

    if (rotation.shouldRotate) {
      const newSessionId = agent.getSessionHandler().rotate(sessionId);
      yield sse({ type: 'session_rotating', reason: rotation.reason });
      yield sse({ type: 'session_rotated', old_session_id: sessionId, new_session_id: newSessionId, reason: rotation.reason });
      activeSessionId = newSessionId;
    }

    let stopped = false;
    for await (const event of agent.handleUserMessage(activeSessionId, message, model)) {
      if (event.type === 'tool_cancelled') stopped = true;
      const frame = toSse(event);
      if (frame) yield frame;
    }
    yield sse({ type: stopped ? 'stopped' : 'done' });
  }
}

// ── SSE serialization ─────────────────────────────────────────────────────────

function toSse(event: ExecutorEvent): SseFrame | null {
  let payload: Record<string, any> | null = null;

  switch (event.type) {
    case 'llm_request':
      payload = {
        type: 'request_json',
        payload: {
          model: event.model,
          max_tokens: event.maxTokens,
          system: event.system,
          messages: event.messages,
          tools: event.tools,
        },
      };
      break;
    case 'llm_text':
      payload = { type: 'llm_text', text: event.text };
      break;
    case 'llm_reasoning':
      payload = { type: 'llm_reasoning', text: event.text };
      break;
    case 'llm_tool_call':
      payload = { type: 'llm_tool_call', name: event.name, input: event.input };
      break;
    case 'llm_response':
      payload = {
        type: 'response_json',
        payload: {
          stop_reason: event.stopReason,
          usage: event.usage,
          content: event.content,
        },
      };
      break;
    case 'tool_confirm_request':
      payload = { type: 'tool_confirm_request', requestId: event.requestId, name: event.name, input: event.input };
      break;
    case 'tool_confirm_denied':
      payload = { type: 'tool_confirm_denied', name: event.name };
      break;
    case 'tool_result':
      payload = { type: 'tool_result', name: event.name, result: event.result };
      break;
    case 'agent_append':
    case 'tool_cancelled':
      return null; // internal — not surfaced to frontend
    default:
      return null;
  }

  return payload ? sse(payload) : null;
}

function sse(data: Record<string, any>): SseFrame {
  return { data: JSON.stringify(data) };
}
