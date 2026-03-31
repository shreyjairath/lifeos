import type { AgentInfo, Session, AgentRun, Channel, Task } from './types';

export async function fetchAgents(): Promise<AgentInfo[]> {
  const res = await fetch('/api/agents');
  if (!res.ok) throw new Error('Failed to fetch agents');
  return res.json();
}

export async function fetchSessions(): Promise<Session[]> {
  const res = await fetch('/api/sessions');
  if (!res.ok) throw new Error('Failed to fetch sessions');
  const data = await res.json();
  return data.sessions ?? data ?? [];
}

export async function createSession(agent: string): Promise<string> {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent }),
  });
  if (!res.ok) throw new Error('Failed to create session');
  const data = await res.json();
  return data.session_id;
}

export async function deleteSession(agent: string, id: string): Promise<void> {
  const res = await fetch(`/api/sessions/${agent}/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete session');
}

export async function pruneSessions(): Promise<void> {
  await fetch('/api/sessions/prune', { method: 'POST' });
}

export interface ChatHistoryMessage {
  role: string;
  content: unknown;
}

export async function fetchChatHistory(sessionId: string): Promise<ChatHistoryMessage[]> {
  const res = await fetch(`/api/chat/${sessionId}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.messages ?? [];
}

export async function stopChat(sessionId: string): Promise<void> {
  await fetch(`/api/chat/${sessionId}/stop`, { method: 'POST' });
}

export async function confirmTool(requestId: string, approved: boolean): Promise<void> {
  await fetch(`/api/tool-confirm/${requestId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approved }),
  });
}

export async function fetchAgentRuns(agentName: string): Promise<AgentRun[]> {
  const res = await fetch(`/api/agents/${agentName}/runs`);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function fetchChannels(): Promise<Channel[]> {
  const res = await fetch('/api/agents/channels');
  if (!res.ok) return [];
  return res.json();
}

export async function fetchChannelContent(pair: string): Promise<string> {
  const res = await fetch(`/api/agents/channels/${encodeURIComponent(pair)}`);
  if (!res.ok) return '';
  const data = await res.json();
  return data.content ?? '';
}

export async function fetchTasks(): Promise<Task[]> {
  const res = await fetch('/api/agents/tasks');
  if (!res.ok) return [];
  return res.json();
}

export async function fetchVapidPublicKey(): Promise<string | null> {
  try {
    const res = await fetch('/api/push/vapid-public-key');
    if (!res.ok) return null;
    const data = await res.json();
    return data.publicKey ?? null;
  } catch {
    return null;
  }
}

export async function subscribePush(subscription: PushSubscription): Promise<void> {
  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription),
  });
}

export async function fetchCcHistory(sessionId: string): Promise<ChatHistoryMessage[]> {
  const res = await fetch(`/api/cc/history?session_id=${encodeURIComponent(sessionId)}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.messages ?? data ?? [];
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
