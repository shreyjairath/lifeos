import type { AgentDefinition } from './agent-definition.js';
import type { SessionHandler } from './session/session-handler.js';
import type { EmailMessage } from '../agentfleet/tools/gmail.js';
import type { EmailThreadStore } from '../agentfleet/tools/email-thread-store.js';

// ── Tool Invocation ──────────────────────────────────────────────────────────

export interface ToolInvoker {
  definitions(): ToolDefinition[];
  invoke(name: string, input: Record<string, any>, agent: string): Record<string, any>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

// ── Agent ────────────────────────────────────────────────────────────────────

export interface Agent {
  readonly emailThreadStore: EmailThreadStore;
  getName(): string;
  getTitle(): string;
  getDescription(): string;
  getDefinition(): AgentDefinition;
  getSessionHandler(): SessionHandler;
  cancel(sessionId: string): void;
  handleUserMessage(
    sessionId: string,
    userMessage: string,
    modelOverride?: string
  ): AsyncGenerator<ExecutorEvent>;
  handleAgentMessage(fromAgent: string, content: string): Promise<string>;
  handleAgentMessageAsync(fromAgent: string, content: string, onComplete?: (response: string) => void): void;
  handleEmailCheck(emails: EmailMessage[], onComplete?: () => Promise<void>): void;
  handleOverdueTask(task: Record<string, any>, onComplete?: () => void): void;
}

// ── Executor Events ──────────────────────────────────────────────────────────

export type ExecutorEvent =
  | LlmRequestEvent
  | LlmTextEvent
  | LlmReasoningEvent
  | LlmToolCallEvent
  | LlmResponseEvent
  | AgentAppendEvent
  | ToolConfirmRequestEvent
  | ToolConfirmDeniedEvent
  | ToolResultEvent
  | ToolCancelledEvent;

export interface LlmRequestEvent {
  type: 'llm_request';
  model: string;
  maxTokens: number;
  system: string;
  messages: Record<string, any>[];
  tools: ToolDefinition[];
}

export interface LlmTextEvent {
  type: 'llm_text';
  text: string;
}

export interface LlmReasoningEvent {
  type: 'llm_reasoning';
  text: string;
}

export interface LlmToolCallEvent {
  type: 'llm_tool_call';
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface LlmResponseEvent {
  type: 'llm_response';
  stopReason: string;
  usage: { input_tokens: number; output_tokens: number };
  content: Record<string, any>[];
}

export interface AgentAppendEvent {
  type: 'agent_append';
  role: string;
  message: Record<string, any>;
}

export interface ToolConfirmRequestEvent {
  type: 'tool_confirm_request';
  requestId: string;
  name: string;
  input: Record<string, any>;
}

export interface ToolConfirmDeniedEvent {
  type: 'tool_confirm_denied';
  name: string;
}

export interface ToolResultEvent {
  type: 'tool_result';
  id: string;
  name: string;
  result: Record<string, any>;
}

export interface ToolCancelledEvent {
  type: 'tool_cancelled';
}
