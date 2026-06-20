export interface AgentInfo {
  name: string;
  title: string;
  description: string;
  effectiveModel?: string;
  disabledModes?: string[];
  manager?: string;
}

export interface Session {
  id: string;
  agent: string;
  title?: string;
  created_at: number;
  last_message_at: number;
  last_input_tokens: number;
}

export interface Message {
  id: string;
  role: 'user' | 'agent' | 'tool' | 'thinking' | 'label';
  text: string;
  timestamp: number;
  agentName?: string;
  toolName?: string;
  toolCallId?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: unknown;
  isStreaming?: boolean;
}

export interface Toast {
  id: string;
  agent: string;
  agentTitle: string;
  message: string;
  urgency: 'low' | 'medium' | 'high';
  context?: string;
}

export interface ConfirmRequest {
  requestId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentRun {
  id?: string;
  agent: string;
  mode: string;
  systemPrompt?: string;
  userMessage?: string;
  /** @deprecated use systemPrompt */
  prompt?: string;
  model?: string;
  turns?: number | Record<string, unknown>[];
  inputTokens?: number;
  outputTokens?: number;
  result?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
}

export interface FeedEntry {
  timestamp: string;
  from: string;
  to: string[];       // empty = broadcast
  threadId: string | null;
  content: string;
}

export interface FeedThread {
  threadId: string;
  participants: string[];
  lastActivity: string;
  entries: FeedEntry[];
  preview: string;
}

export interface Task {
  id: string;
  name: string;
  created_by?: string;
  assigned_to?: string;
  description?: string;
  cadence_hours?: number;
  due_at?: number;
  next_due?: string;
  last_run?: number;
  assignee?: string;
  completed_at?: string;
  status?: string;
}

export interface JournalEntry {
  id: string;
  title: string;
  date: string;
  preview: string;
  content?: string;
}

export type SseEvent =
  | { type: 'llm_text'; text: string }
  | { type: 'llm_reasoning'; text: string }
  | { type: 'llm_tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; result: unknown }
  | { type: 'tool_confirm_request'; requestId: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_confirm_denied'; name: string }
  | { type: 'tool_cancelled' }
  | { type: 'session_id'; session_id: string }
  | { type: 'session_rotated'; old_session_id: string; new_session_id: string }
  | { type: 'agent_run_complete'; usage: { input_tokens: number; output_tokens: number } }
  | { type: 'done' }
  | { type: 'stopped' }
  | { type: 'error'; text: string };

export type GlobalEvent =
  | { type: 'notification'; agent: string; agentTitle: string; message: string; urgency: 'low' | 'medium' | 'high'; context?: string }
  | { type: 'reminder'; message: string }
  | { type: 'agents_updated' }
  | { type: 'artifact_updated'; agent: string; url: string; title: string };
