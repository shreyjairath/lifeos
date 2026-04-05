import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { MONOREPO_ROOT } from '../root.js';

const AGENTS_DIR = resolve(MONOREPO_ROOT, '.user-data/agents');

const MAX_TEXT_LEN = 5_000;
const MAX_TOOL_INPUT_LEN = 1_000;
const MAX_TOOL_RESULT_LEN = 2_000;
const MAX_REASONING_LEN = 20_000;
const MAX_INITIAL_MESSAGES = 50;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export interface RunRecord {
  id: string;
  agent: string;
  mode: string;
  model: string;
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
}

export function createRunRecord(agent: string, mode: string, systemPrompt: string, userMessage: string, model: string): RunRecord {
  return {
    id: randomUUID(),
    agent,
    mode,
    model,
    startedAt: Date.now(),
    inputTokens: 0,
    outputTokens: 0,
    systemPrompt,
    userMessage,
    turns: [],
    result: '',
  };
}

export function finishRunRecord(record: RunRecord, result: string): void {
  record.endedAt = Date.now();
  record.durationMs = record.endedAt - record.startedAt;
  record.result = result;
}

export function addTokens(record: RunRecord, input: number, output: number): void {
  record.inputTokens += input;
  record.outputTokens += output;
}

export function addTurn(record: RunRecord, role: string, message: Record<string, any>): void {
  const turn: Record<string, any> = { role };
  const content = message.content;
  if (typeof content === 'string') {
    turn.content = truncate(content, role === 'tool' ? MAX_TOOL_RESULT_LEN : MAX_TEXT_LEN);
  }
  if (message.reasoning && typeof message.reasoning === 'string') {
    turn.reasoning = truncate(message.reasoning, MAX_REASONING_LEN);
  }
  if (Array.isArray(message.tool_calls)) {
    turn.tool_calls = message.tool_calls.map((tc: any) => ({
      name: tc.function?.name,
      arguments: truncate(tc.function?.arguments ?? '{}', MAX_TOOL_INPUT_LEN),
    }));
  }
  record.turns.push(turn);
}

export function setInitialMessages(record: RunRecord, messages: Record<string, any>[]): void {
  record.initialMessages = messages.slice(0, MAX_INITIAL_MESSAGES).map((m) => {
    const msg: Record<string, any> = { role: m.role };
    if (typeof m.content === 'string') msg.content = truncate(m.content, MAX_TEXT_LEN);
    return msg;
  });
}

export function saveRunRecord(record: RunRecord): void {
  const runsDir = resolve(AGENTS_DIR, record.agent, 'runs');
  mkdirSync(runsDir, { recursive: true });
  const filename = `${record.startedAt}_${record.id}.json`;
  writeFileSync(resolve(runsDir, filename), JSON.stringify(record, null, 2), 'utf-8');
}

export function getRecentRuns(agent: string, limit: number = 20): Record<string, any>[] {
  const runsDir = resolve(AGENTS_DIR, agent, 'runs');
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
