'use client';

import { useEffect, useRef } from 'react';

export interface DebugEvent {
  ts: number;
  type: string;
  data: unknown;
}

interface Props {
  events: DebugEvent[];
  onClose: () => void;
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function typeColor(type: string): string {
  if (type === 'llm_text' || type === 'llm_reasoning') return 'var(--accent)';
  if (type === 'llm_tool_call' || type === 'tool_result') return 'var(--warning, #f5a623)';
  if (type === 'error') return 'var(--danger)';
  if (type === 'done' || type === 'stopped') return 'var(--success)';
  return 'var(--chrome-text)';
}

export default function StreamDebugOverlay({ events, onClose }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  return (
    <div className="stream-debug-overlay">
      <div className="stream-debug-header">
        <span>Stream Debug</span>
        <button className="stream-debug-close" onClick={onClose}>×</button>
      </div>
      <div className="stream-debug-body">
        {events.length === 0 && (
          <div className="stream-debug-empty">No events yet. Send a message.</div>
        )}
        {events.map((ev, i) => (
          <div className="debug-event" key={i}>
            <div>
              <span className="debug-event-ts">[{formatTs(ev.ts)}]</span>{' '}
              <span className="debug-event-type" style={{ color: typeColor(ev.type) }}>{ev.type}</span>
            </div>
            <div className="debug-event-data">
              {JSON.stringify(ev.data, null, 2)}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
