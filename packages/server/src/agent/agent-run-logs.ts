import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';

const MAX_INITIAL_MESSAGES = 50;

export type RunStatus = 'success' | 'error' | 'max_turns';

export interface RunRecord {
  id: string;
  agent: string;
  mode: string;
  model: string;
  sessionId?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  inputTokens: number;
  outputTokens: number;
  systemPrompt: string;
  userMessage: string;
  toolNames?: string[];
  turns: Record<string, any>[];
  initialMessages?: Record<string, any>[];
  result: string;
  status?: RunStatus;
}

export function createRunRecord(agent: string, mode: string, systemPrompt: string, userMessage: string, model: string, sessionId?: string): RunRecord {
  return {
    id: randomUUID(),
    agent,
    mode,
    model,
    sessionId,
    startedAt: Date.now(),
    inputTokens: 0,
    outputTokens: 0,
    systemPrompt,
    userMessage,
    turns: [],
    result: '',
  };
}

export function finishRunRecord(record: RunRecord, result: string, status: RunStatus = 'success'): void {
  record.endedAt = Date.now();
  record.durationMs = record.endedAt - record.startedAt;
  record.result = result;
  record.status = status;
}

export function addTokens(record: RunRecord, input: number, output: number): void {
  record.inputTokens += input;
  record.outputTokens += output;
}

const TOOL_PREVIEW_CHARS = 120;

export function addTurn(record: RunRecord, role: string, message: Record<string, any>): void {
  const turn: Record<string, any> = { role };
  const content = message.content;
  if (typeof content === 'string') {
    turn.content = role === 'tool'
      ? content.slice(0, TOOL_PREVIEW_CHARS) + (content.length > TOOL_PREVIEW_CHARS ? '…' : '')
      : content;
  }
  if (message.reasoning && typeof message.reasoning === 'string') {
    turn.reasoning = message.reasoning;
  }
  if (Array.isArray(message.tool_calls)) {
    turn.tool_calls = message.tool_calls.map((tc: any) => ({
      name: tc.function?.name,
      arguments: tc.function?.arguments ?? '{}',
    }));
  }
  record.turns.push(turn);
}

export function setInitialMessages(record: RunRecord, messages: Record<string, any>[]): void {
  record.initialMessages = messages.slice(0, MAX_INITIAL_MESSAGES).map((m) => {
    const msg: Record<string, any> = { role: m.role };
    if (typeof m.content === 'string') msg.content = m.content;
    return msg;
  });
}

export function saveRunRecord(record: RunRecord, agentsDir: string): void {
  const runsDir = resolve(agentsDir, record.agent, 'runs');
  mkdirSync(runsDir, { recursive: true });
  const filename = `${record.startedAt}_${record.id}.json`;
  writeFileSync(resolve(runsDir, filename), JSON.stringify(record, null, 2), 'utf-8');
}

export function getRecentRuns(agent: string, agentsDir: string, limit: number = 20): Record<string, any>[] {
  const runsDir = resolve(agentsDir, agent, 'runs');
  if (!existsSync(runsDir)) return [];

  const files = readdirSync(runsDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit);

  return files.map((f) => {
    try {
      return JSON.parse(readFileSync(resolve(runsDir, f), 'utf-8'));
    } catch {
      return null;
    }
  }).filter(Boolean) as Record<string, any>[];
}
