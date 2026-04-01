'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import MessageBubble from './MessageBubble';
import ConfirmDialog from './ConfirmDialog';
import StreamDebugOverlay, { type DebugEvent } from './StreamDebugOverlay';
import { fetchChatHistory, stopChat, confirmTool } from '@/lib/api';
import type { Message, SseEvent, ConfirmRequest, AgentInfo } from '@/lib/types';

interface ChatPanelProps {
  agent: AgentInfo | undefined;
  sessionId: string | null;
  modelOverride: string;
  artifactOpen: boolean;
  onSessionCreated: (sessionId: string) => void;
  onSessionRotated: (newSessionId: string) => void;
  onOpenArtifact: (url: string, title: string) => void;
  onToggleArtifacts: () => void;
}

function nanoid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function ChatPanel({
  agent,
  sessionId,
  modelOverride,
  artifactOpen,
  onSessionCreated,
  onSessionRotated,
  onOpenArtifact,
  onToggleArtifacts,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [debugOpen, setDebugOpen] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('chief-debug') === 'true';
  });
  const [debugEvents, setDebugEvents] = useState<DebugEvent[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const currentSessionRef = useRef<string | null>(sessionId);

  // Track current active streaming message id
  const streamingMsgId = useRef<string | null>(null);

  useEffect(() => {
    currentSessionRef.current = sessionId;
  }, [sessionId]);

  // Load history when session changes
  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      return;
    }
    setLoadingHistory(true);
    fetchChatHistory(agent?.name ?? '', sessionId)
      .then(hist => {
        const msgs: Message[] = [];
        hist.forEach((m, i) => {
          if (m.role === 'user') {
            const text = typeof m.content === 'string'
              ? m.content
              : Array.isArray(m.content)
                ? (m.content as Array<{ type: string; text?: string }>)
                    .filter(c => c.type === 'text')
                    .map(c => c.text ?? '')
                    .join('')
                : '';
            if (text) {
              msgs.push({ id: nanoid(), role: 'user', text, timestamp: Date.now() + i });
            }
          } else if (m.role === 'assistant') {
            const content = m.content;
            if (Array.isArray(content)) {
              let agentText = '';
              content.forEach((block: unknown) => {
                const b = block as Record<string, unknown>;
                if (b.type === 'thinking') {
                  msgs.push({
                    id: nanoid(),
                    role: 'thinking',
                    text: String(b.thinking ?? b.text ?? ''),
                    timestamp: Date.now() + i,
                  });
                } else if (b.type === 'text') {
                  agentText += String(b.text ?? '');
                } else if (b.type === 'tool_use') {
                  if (agentText) {
                    msgs.push({ id: nanoid(), role: 'agent', text: agentText, timestamp: Date.now() + i });
                    agentText = '';
                  }
                  msgs.push({
                    id: nanoid(),
                    role: 'tool',
                    text: '',
                    toolName: String(b.name ?? ''),
                    toolInput: b.input as Record<string, unknown>,
                    timestamp: Date.now() + i,
                  });
                }
              });
              if (agentText) {
                msgs.push({ id: nanoid(), role: 'agent', text: agentText, timestamp: Date.now() + i });
              }
            } else if (typeof content === 'string' && content) {
              msgs.push({ id: nanoid(), role: 'agent', text: content, timestamp: Date.now() + i });
            }
          } else if (m.role === 'tool') {
            // Tool results — attach to last tool message
            const last = msgs.findLast(msg => msg.role === 'tool' && !msg.toolResult);
            if (last) {
              last.toolResult = m.content;
            }
          }
        });
        setMessages(msgs);
        setLoadingHistory(false);
      })
      .catch(() => setLoadingHistory(false));
  }, [sessionId]);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Auto-resize textarea
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  };

  const sendMessage = useCallback(async () => {
    if (!input.trim() || streaming || !agent) return;

    const msg = input.trim();
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    // Optimistically add user message
    const userMsg: Message = {
      id: nanoid(),
      role: 'user',
      text: msg,
      timestamp: Date.now(),
    };
    setMessages(prev => [...prev, userMsg]);
    setStreaming(true);

    setDebugEvents([]);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Agent response message (we'll build it up)
    const agentMsgId = nanoid();
    streamingMsgId.current = agentMsgId;
    setMessages(prev => [
      ...prev,
      { id: agentMsgId, role: 'agent', text: '', timestamp: Date.now(), isStreaming: true },
    ]);

    let activeSessionId = currentSessionRef.current;

    try {
      const body: Record<string, unknown> = {
        message: msg,
        agent: agent.name,
      };
      if (activeSessionId) body.session_id = activeSessionId;
      if (modelOverride.trim()) body.model = modelOverride.trim();

      const apiBase = process.env.NEXT_PUBLIC_API_URL ?? '';
      const res = await fetch(`${apiBase}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let agentText = '';

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

          let event: SseEvent;
          try {
            event = JSON.parse(data);
          } catch { continue; }

          setDebugEvents(prev => [...prev, { ts: Date.now(), type: event.type, data: event }]);

          switch (event.type) {
            case 'session_id': {
              activeSessionId = event.session_id;
              currentSessionRef.current = event.session_id;
              onSessionCreated(event.session_id);
              break;
            }
            case 'session_rotated': {
              activeSessionId = event.new_session_id;
              currentSessionRef.current = event.new_session_id;
              onSessionRotated(event.new_session_id);
              break;
            }
            case 'llm_reasoning': {
              const thinkId = nanoid();
              const currentStreamId = streamingMsgId.current;
              setMessages(prev => {
                // If there's already a streaming thinking block, append to it
                const existingThink = prev.find(m => m.role === 'thinking' && m.isStreaming);
                if (existingThink) {
                  return prev.map(m => m.id === existingThink.id ? { ...m, text: m.text + event.text } : m);
                }
                // Insert new thinking block before the streaming agent placeholder
                const idx = prev.findIndex(m => m.id === currentStreamId);
                const newThink = { id: thinkId, role: 'thinking' as const, text: event.text, timestamp: Date.now(), isStreaming: true };
                if (idx >= 0) {
                  const next = [...prev];
                  next.splice(idx, 0, newThink);
                  return next;
                }
                return [...prev, newThink];
              });
              break;
            }
            case 'llm_text': {
              agentText += event.text;
              const currentId = streamingMsgId.current;
              const textSnapshot = agentText;
              setMessages(prev =>
                prev.map(m => {
                  if (m.id === currentId) return { ...m, text: textSnapshot, isStreaming: true };
                  if (m.role === 'thinking' && m.isStreaming) return { ...m, isStreaming: false };
                  return m;
                })
              );
              break;
            }
            case 'llm_tool_call': {
              const oldPlaceholderId = streamingMsgId.current;
              agentText = '';
              // Finalize pre-tool text bubble (keep it, just stop streaming)
              setMessages(prev =>
                prev.map(m => m.id === oldPlaceholderId ? { ...m, isStreaming: false } : m)
              );
              // Add tool call message
              const toolMsgId = nanoid();
              setMessages(prev => [
                ...prev,
                {
                  id: toolMsgId,
                  role: 'tool',
                  text: '',
                  toolName: event.name,
                  toolCallId: event.id,
                  toolInput: event.input,
                  timestamp: Date.now(),
                },
              ]);
              // Start new agent text message
              const newMsgId = nanoid();
              streamingMsgId.current = newMsgId;
              setMessages(prev => [
                ...prev,
                { id: newMsgId, role: 'agent', text: '', timestamp: Date.now(), isStreaming: true },
              ]);
              break;
            }
            case 'tool_result': {
              setMessages(prev => {
                const updated = [...prev];
                for (let i = updated.length - 1; i >= 0; i--) {
                  if (updated[i].role === 'tool' && updated[i].toolCallId === event.id) {
                    updated[i] = { ...updated[i], toolResult: event.result };
                    break;
                  }
                }
                return updated;
              });
              // Open artifact panel when render_artifact tool completes
              if (event.name === 'render_artifact') {
                const res = event.result as Record<string, unknown>;
                if (res?.url) onOpenArtifact(String(res.url), String(res.title ?? ''));
              }
              break;
            }
            case 'tool_confirm_request': {
              setConfirmRequest({ requestId: event.requestId, name: event.name, input: event.input });
              break;
            }
            case 'tool_confirm_denied': {
              setConfirmRequest(null);
              break;
            }
            case 'tool_cancelled': {
              setConfirmRequest(null);
              break;
            }
            case 'done':
            case 'stopped': {
              setMessages(prev =>
                prev
                  .map(m => m.isStreaming ? { ...m, isStreaming: false } : m)
                  .filter(m => !(m.role === 'agent' && !m.text))
              );
              break;
            }
            case 'error': {
              setMessages(prev =>
                prev.map(m =>
                  m.id === agentMsgId
                    ? { ...m, text: `Error: ${event.text}`, isStreaming: false }
                    : m
                )
              );
              break;
            }
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setMessages(prev =>
          prev.map(m =>
            m.id === agentMsgId
              ? { ...m, text: 'Request failed. Please try again.', isStreaming: false }
              : m
          )
        );
      }
    } finally {
      setStreaming(false);
      streamingMsgId.current = null;
      abortRef.current = null;
      // Final cleanup: stop all streaming flags + remove all empty agent placeholders
      setMessages(prev =>
        prev
          .map(m => m.isStreaming ? { ...m, isStreaming: false } : m)
          .filter(m => !(m.role === 'agent' && !m.text))
      );
    }
  }, [input, streaming, agent, modelOverride, onSessionCreated, onSessionRotated]);

  const handleStop = async () => {
    abortRef.current?.abort();
    if (currentSessionRef.current) {
      await stopChat(agent?.name ?? '', currentSessionRef.current).catch(() => {});
    }
    setStreaming(false);
    setMessages(prev => prev.map(m => m.isStreaming ? { ...m, isStreaming: false } : m));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleConfirmApprove = async () => {
    if (!confirmRequest) return;
    await confirmTool(confirmRequest.requestId, true);
    setConfirmRequest(null);
  };

  const handleConfirmDeny = async () => {
    if (!confirmRequest) return;
    await confirmTool(confirmRequest.requestId, false);
    setConfirmRequest(null);
  };

  return (
    <div className="chat-panel">
      {/* Header */}
      <div className="chat-header">
        <span className="chat-header-title">
          {agent?.title ?? agent?.name ?? 'Select an agent'}
        </span>
        {sessionId && (
          <span className="chat-header-meta">
            {sessionId.slice(0, 16)}...
          </span>
        )}
        {agent?.effectiveModel && (
          <span className="chat-header-meta">{agent.effectiveModel.split('/').pop()}</span>
        )}
        <div className="chat-header-actions">
          <button
            className={`icon-btn${debugOpen ? ' active' : ''}`}
            title="Toggle stream debug"
            onClick={() => {
              const v = !debugOpen;
              setDebugOpen(v);
              localStorage.setItem('chief-debug', String(v));
            }}
          >
            ⚡
          </button>
          <button
            className={`icon-btn${artifactOpen ? ' active' : ''}`}
            title="Toggle artifacts panel"
            onClick={onToggleArtifacts}
          >
            📄
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="messages-container">
        <div className="messages-inner">
          {loadingHistory && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', justifyContent: 'center' }}>
              <span className="loading-spinner" /> Loading history...
            </div>
          )}

          {!loadingHistory && messages.length === 0 && (
            <div className="empty-chat">
              <div className="empty-chat-title">
                {agent?.title ?? 'chief'}
              </div>
              <div className="empty-chat-subtitle">
                {agent?.description ?? 'Your personal AI agent team. Start a conversation.'}
              </div>
            </div>
          )}

          {messages.map((msg, i) => {
            const name = (msg.role === 'agent' || msg.role === 'thinking') ? (agent?.title ?? agent?.name) : undefined;
            let showLabel = true;
            if (msg.role === 'agent') {
              for (let j = i - 1; j >= 0; j--) {
                const prev = messages[j];
                if (prev.role === 'user') break;
                if (prev.role === 'thinking') { showLabel = false; break; }
              }
            }
            return <MessageBubble key={msg.id} message={msg} agentName={name} showLabel={showLabel} />;
          })}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <div className="chat-input-area">
        <div className="chat-input-row">
          <textarea
            ref={textareaRef}
            className="chat-textarea"
            placeholder={agent ? `Message ${agent.title ?? agent.name}...` : 'Select an agent to start...'}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={!agent || streaming}
          />
          <div className="chat-input-actions">
            <button
              className="icon-btn"
              title="Microphone (coming soon)"
              disabled
            >
              🎤
            </button>
            {streaming ? (
              <button className="stop-btn" onClick={handleStop}>
                Stop
              </button>
            ) : (
              <button
                className="send-btn"
                onClick={sendMessage}
                disabled={!input.trim() || !agent}
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Confirm dialog */}
      {confirmRequest && (
        <ConfirmDialog
          request={confirmRequest}
          onApprove={handleConfirmApprove}
          onDeny={handleConfirmDeny}
        />
      )}

      {/* Stream debug overlay */}
      {debugOpen && (
        <StreamDebugOverlay
          events={debugEvents}
          onClose={() => {
            setDebugOpen(false);
            localStorage.setItem('chief-debug', 'false');
          }}
        />
      )}
    </div>
  );
}
