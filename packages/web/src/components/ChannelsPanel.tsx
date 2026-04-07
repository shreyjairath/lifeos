'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { useEffect, useState } from 'react';
import { fetchTopicEntries } from '@/lib/api';
import type { FeedEntry } from '@/lib/types';

function formatRelativeTime(ts: string): string {
  try {
    const diff = Date.now() - new Date(ts).getTime();
    if (isNaN(diff)) return ts;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  } catch { return ts; }
}

function formatAbsoluteTime(ts: string): string {
  try {
    return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return ts; }
}

function agentColor(name: string): string {
  const colors = ['#6366f1','#0ea5e9','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) & 0xffff;
  return colors[hash % colors.length]!;
}

function AgentPill({ name }: { name: string }) {
  const color = agentColor(name);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '1px 7px', borderRadius: 10,
      background: `${color}18`, border: `1px solid ${color}40`,
      fontSize: 11, fontWeight: 500, color,
    }}>
      {name.replace(/_/g, ' ')}
    </span>
  );
}

function FeedEntryCard({ entry, prevEntry }: { entry: FeedEntry; prevEntry?: FeedEntry }) {
  const day = entry.timestamp ? new Date(entry.timestamp).toDateString() : null;
  const prevDay = prevEntry?.timestamp ? new Date(prevEntry.timestamp).toDateString() : null;
  const showDivider = day && prevDay && day !== prevDay;

  return (
    <>
      {showDivider && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0' }}>
          <div style={{ flex: 1, height: 1, background: 'var(--border-light)' }} />
          <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            {new Date(entry.timestamp).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
          </span>
          <div style={{ flex: 1, height: 1, background: 'var(--border-light)' }} />
        </div>
      )}
      <div className="topic-entry">
        <div className="topic-entry-header">
          <AgentPill name={entry.from} />
          {entry.to && entry.to.length > 0 && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
              → {entry.to.map((t) => <AgentPill key={t} name={t} />)}
            </span>
          )}
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title={formatAbsoluteTime(entry.timestamp)}>
            {formatRelativeTime(entry.timestamp)}
          </span>
        </div>
        <div className="topic-entry-body markdown-content">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{entry.content}</ReactMarkdown>
        </div>
      </div>
    </>
  );
}

export default function ChannelsPanel({ topic }: { topic: string }) {
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchTopicEntries(topic)
      .then((data) => { setEntries(data); setLoading(false); })
      .catch(() => { setEntries([]); setLoading(false); });
  }, [topic]);

  if (loading) return (
    <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
  );

  return (
    <div className="topic-feed">
      {entries.length === 0 ? (
        <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>No entries yet.</div>
      ) : (
        entries.map((entry, i) => (
          <FeedEntryCard key={i} entry={entry} prevEntry={entries[i - 1]} />
        ))
      )}
    </div>
  );
}
