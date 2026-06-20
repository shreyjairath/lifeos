import type { AgentInfo, Session, AgentRun, FeedEntry, Task, JournalEntry } from './types';

const BACKEND_PORT = 8000;

export function getApiBase(): string {
  if (typeof window === 'undefined') return '';
  const host = window.location.hostname;
  return `http://${host}:${BACKEND_PORT}`;
}

export async function fetchAgents(): Promise<AgentInfo[]> {
  const res = await fetch(`${getApiBase()}/api/agents`);
  if (!res.ok) throw new Error('Failed to fetch agents');
  return res.json();
}

export async function fetchSessions(): Promise<Session[]> {
  const res = await fetch(`${getApiBase()}/api/sessions`);
  if (!res.ok) throw new Error('Failed to fetch sessions');
  const data = await res.json();
  return data.sessions ?? data ?? [];
}

export async function createSession(agent: string): Promise<string> {
  const res = await fetch(`${getApiBase()}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent }),
  });
  if (!res.ok) throw new Error('Failed to create session');
  const data = await res.json();
  return data.session_id;
}

export async function deleteSession(agent: string, id: string): Promise<void> {
  const res = await fetch(`${getApiBase()}/api/sessions/${agent}/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete session');
}

export async function pruneSessions(): Promise<void> {
  await fetch(`${getApiBase()}/api/sessions/prune`, { method: 'POST' });
}

export interface ChatHistoryMessage {
  role: string;
  content: unknown;
}

export async function fetchChatHistory(agent: string, sessionId: string): Promise<ChatHistoryMessage[]> {
  const res = await fetch(`${getApiBase()}/api/chat/${agent}/${sessionId}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.messages ?? [];
}

export async function stopChat(agent: string, sessionId: string): Promise<void> {
  await fetch(`${getApiBase()}/api/chat/${agent}/${sessionId}/stop`, { method: 'POST' });
}

export async function confirmTool(requestId: string, approved: boolean): Promise<void> {
  await fetch(`${getApiBase()}/api/tool-confirm/${requestId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approved }),
  });
}

export async function fetchAgentRuns(agentName: string): Promise<AgentRun[]> {
  const res = await fetch(`${getApiBase()}/api/agents/${agentName}/runs`);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function fetchFeed(): Promise<FeedEntry[]> {
  const res = await fetch(`${getApiBase()}/api/agents/feed`);
  if (!res.ok) return [];
  return res.json();
}

export async function fetchTopics(): Promise<{ name: string; count: number; lastActivity: string | null }[]> {
  const res = await fetch(`${getApiBase()}/api/agents/topics`);
  if (!res.ok) return [];
  return res.json();
}

export async function fetchTopicEntries(topic: string): Promise<FeedEntry[]> {
  const res = await fetch(`${getApiBase()}/api/agents/topics/${encodeURIComponent(topic)}`);
  if (!res.ok) return [];
  return res.json();
}

export async function fetchTasks(): Promise<Task[]> {
  const res = await fetch(`${getApiBase()}/api/agents/tasks`);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : (data.tasks ?? []);
}

export async function fetchVapidPublicKey(): Promise<string | null> {
  try {
    const res = await fetch(`${getApiBase()}/api/push/vapid-public-key`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.publicKey ?? null;
  } catch {
    return null;
  }
}

export async function subscribePush(subscription: PushSubscription): Promise<void> {
  await fetch(`${getApiBase()}/api/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription),
  });
}

export async function fetchCcHistory(sessionId: string): Promise<ChatHistoryMessage[]> {
  const res = await fetch(`${getApiBase()}/api/cc/history?session_id=${encodeURIComponent(sessionId)}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.messages ?? data ?? [];
}

export async function fetchJournalEntries(): Promise<JournalEntry[]> {
  const res = await fetch(`${getApiBase()}/api/journal`);
  if (!res.ok) return [];
  return res.json();
}

export async function fetchJournalEntry(id: string): Promise<JournalEntry | null> {
  const res = await fetch(`${getApiBase()}/api/journal/${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  return res.json();
}

export async function createJournalEntry(content: string): Promise<JournalEntry> {
  const res = await fetch(`${getApiBase()}/api/journal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error('Failed to create journal entry');
  return res.json();
}

export async function updateJournalEntry(id: string, content: string): Promise<JournalEntry> {
  const res = await fetch(`${getApiBase()}/api/journal/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error('Failed to update journal entry');
  return res.json();
}

export async function deleteJournalEntry(id: string): Promise<void> {
  await fetch(`${getApiBase()}/api/journal/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
