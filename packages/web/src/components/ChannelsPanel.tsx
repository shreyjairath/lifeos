'use client';

import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fetchFeed } from '@/lib/api';
import type { FeedEntry, FeedThread } from '@/lib/types';

function groupByThread(entries: FeedEntry[]): FeedThread[] {
  const map = new Map<string, FeedThread>();
  // entries are newest-first from the API; iterate in reverse to build threads chronologically
  for (const entry of [...entries].reverse()) {
    if (!map.has(entry.threadId)) {
      map.set(entry.threadId, {
        threadId: entry.threadId,
        participants: [],
        lastActivity: entry.timestamp,
        entries: [],
        preview: '',
      });
    }
    const thread = map.get(entry.threadId)!;
    thread.entries.push(entry);
    thread.lastActivity = entry.timestamp; // last entry is most recent
    if (!thread.participants.includes(entry.from)) thread.participants.push(entry.from);
    thread.preview = entry.content.slice(0, 100);
  }
  // Return threads sorted newest-first
  return [...map.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

function formatRelativeTime(ts: string): string {
  try {
    const date = new Date(ts);
    const diff = Date.now() - date.getTime();
    if (isNaN(diff)) return ts;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  } catch {
    return ts;
  }
}

function agentLabel(name: string): string {
  return name.replace(/_/g, ' ');
}

function ChatBubble({ content, side, agent }: { content: string; side: 'left' | 'right'; agent: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: side === 'left' ? 'flex-start' : 'flex-end' }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3, paddingLeft: side === 'left' ? 4 : 0, paddingRight: side === 'right' ? 4 : 0 }}>
        {agentLabel(agent)}
      </div>
      <div style={{
        maxWidth: '80%',
        padding: '8px 12px',
        borderRadius: side === 'left' ? '4px 12px 12px 12px' : '12px 4px 12px 12px',
        background: side === 'left' ? 'var(--surface)' : 'var(--accent-bg, #1a2f4a)',
        border: `1px solid ${side === 'left' ? 'var(--border)' : 'var(--accent, #2d5a8e)'}`,
        fontSize: 13,
        lineHeight: 1.5,
        color: 'var(--text)',
      }}>
        <div className="markdown-content" style={{ fontSize: 13 }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

function ThreadView({ thread }: { thread: FeedThread }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const firstAgent = thread.participants[0] ?? '';

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [thread.threadId]);

  return (
    <div style={{ overflowY: 'auto', flex: 1, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      {thread.entries.map((entry, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
            {formatRelativeTime(entry.timestamp)}
          </div>
          <ChatBubble
            content={entry.content}
            side={entry.from === firstAgent ? 'left' : 'right'}
            agent={entry.from}
          />
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

export default function ChannelsPanel() {
  const [threads, setThreads] = useState<FeedThread[]>([]);
  const [selected, setSelected] = useState<FeedThread | null>(null);

  useEffect(() => {
    fetchFeed()
      .then((entries) => {
        const grouped = groupByThread(entries);
        setThreads(grouped);
      })
      .catch(() => setThreads([]));
  }, []);

  return (
    <div className="channels-layout">
      <div className="channels-list">
        {threads.length === 0 && (
          <div style={{ padding: '8px 4px', fontSize: 13, color: 'var(--text-muted)' }}>
            No messages yet
          </div>
        )}
        {threads.map((thread) => (
          <div
            key={thread.threadId}
            className={`channel-item${selected?.threadId === thread.threadId ? ' active' : ''}`}
            onClick={() => setSelected(thread)}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
              <div className="channel-agents">
                {thread.participants.map((a, i) => (
                  <span key={a}>
                    <span className="channel-agent-tag">{agentLabel(a)}</span>
                    {i < thread.participants.length - 1 && (
                      <span style={{ color: 'var(--text-muted)', margin: '0 3px', fontSize: 11 }}>↔</span>
                    )}
                  </span>
                ))}
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                {formatRelativeTime(thread.lastActivity)}
              </span>
            </div>
            {thread.preview && (
              <div className="channel-item-preview">{thread.preview}</div>
            )}
          </div>
        ))}
      </div>

      <div className="channel-content">
        {!selected ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: 16 }}>
            Select a thread to view the conversation.
          </div>
        ) : (
          <ThreadView key={selected.threadId} thread={selected} />
        )}
      </div>
    </div>
  );
}
