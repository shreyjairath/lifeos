'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fetchCcHistory } from '@/lib/api';

const CC_SESSION_KEY = 'lifeos-cc-session-id';

interface CcMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

export default function CcPanel() {
  const [sessionId] = useState<string>(() => {
    if (typeof window === 'undefined') return crypto.randomUUID();
    const stored = localStorage.getItem(CC_SESSION_KEY);
    if (stored) return stored;
    const id = crypto.randomUUID();
    localStorage.setItem(CC_SESSION_KEY, id);
    return id;
  });

  const [messages, setMessages] = useState<CcMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetchCcHistory(sessionId).then(hist => {
      const msgs: CcMessage[] = hist.flatMap((m, i) => {
        const role = m.role === 'user' ? 'user' : 'assistant';
        const content = m.content;
        let text = '';
        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          text = content
            .filter((c: unknown) => typeof c === 'object' && c !== null && (c as Record<string,unknown>).type === 'text')
            .map((c: unknown) => (c as Record<string,unknown>).text as string)
            .join('');
        }
        return text ? [{ role, text, timestamp: Date.now() + i }] : [];
      });
      setMessages(msgs);
    }).catch(() => {});
  }, [sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  const send = useCallback(async () => {
    if (!input.trim() || streaming) return;
    const msg = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', text: msg, timestamp: Date.now() }]);
    setStreaming(true);
    setStreamingText('');

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch('/api/cc/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, session_id: sessionId }),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error('Request failed');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const event = JSON.parse(data);
            if (event.type === 'llm_text' || event.type === 'text') {
              accumulated += event.text ?? '';
              setStreamingText(accumulated);
            } else if (event.type === 'agent_run_complete' || event.type === 'done') {
              break;
            }
          } catch { /* skip */ }
        }
      }

      if (accumulated) {
        setMessages(prev => [...prev, { role: 'assistant', text: accumulated, timestamp: Date.now() }]);
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setMessages(prev => [
          ...prev,
          { role: 'assistant', text: 'Error: request failed.', timestamp: Date.now() },
        ]);
      }
    } finally {
      setStreaming(false);
      setStreamingText('');
      abortRef.current = null;
    }
  }, [input, sessionId, streaming]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="cc-panel">
      <div
        style={{
          flex: 1,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
        }}
      >
        <div
          style={{
            padding: '8px 12px',
            borderBottom: '1px solid var(--border)',
            fontSize: 12,
            color: 'var(--text-muted)',
            background: 'var(--tool-bg)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span>🤖</span>
          <span style={{ fontWeight: 600 }}>Claude Code Sidecar</span>
          <span style={{ marginLeft: 'auto', fontSize: 10 }}>
            session: {sessionId.slice(0, 8)}...
          </span>
        </div>

        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          {messages.length === 0 && !streaming && (
            <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', marginTop: 20 }}>
              Ask Claude Code anything about the codebase.
            </div>
          )}
          {messages.map((m, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: m.role === 'user' ? 'flex-end' : 'flex-start',
              }}
            >
              {m.role === 'user' ? (
                <div
                  style={{
                    background: 'var(--accent)',
                    color: '#fff',
                    padding: '8px 12px',
                    borderRadius: 8,
                    maxWidth: '80%',
                    whiteSpace: 'pre-wrap',
                    fontSize: 13,
                  }}
                >
                  {m.text}
                </div>
              ) : (
                <div
                  style={{
                    background: 'var(--bg)',
                    border: '1px solid var(--border)',
                    padding: '8px 12px',
                    borderRadius: 8,
                    maxWidth: '90%',
                    fontSize: 13,
                  }}
                >
                  <div className="markdown-content">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                  </div>
                </div>
              )}
            </div>
          ))}
          {streaming && streamingText && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
              <div
                style={{
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  padding: '8px 12px',
                  borderRadius: 8,
                  maxWidth: '90%',
                  fontSize: 13,
                }}
                className="streaming-cursor"
              >
                <div className="markdown-content">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown>
                </div>
              </div>
            </div>
          )}
          {streaming && !streamingText && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 12 }}>
              <span className="loading-spinner" /> Thinking...
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="chat-input-area" style={{ padding: 0 }}>
        <div className="chat-input-row">
          <textarea
            className="chat-textarea"
            placeholder="Ask about the codebase..."
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={streaming}
          />
          <div className="chat-input-actions">
            {streaming ? (
              <button
                className="stop-btn"
                onClick={() => { abortRef.current?.abort(); setStreaming(false); }}
              >
                Stop
              </button>
            ) : (
              <button className="send-btn" onClick={send} disabled={!input.trim()}>
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
