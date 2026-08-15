'use client';

import type { AgentInfo, Session } from '@/lib/types';

const THEMES = [
  { id: 'forest', color: '#34c759', label: 'Forest' },
  { id: 'sand',   color: '#c8a882', label: 'Sand' },
  { id: 'slate',  color: '#4a7fa5', label: 'Slate' },
  { id: 'linen',  color: '#f0700a', label: 'Linen' },
  { id: 'sage',   color: '#3a8c52', label: 'Sage' },
  { id: 'sky',    color: '#4a7fa5', label: 'Sky' },
];

interface SidebarProps {
  agents: AgentInfo[];
  sessions: Session[];
  activeAgent: string;
  activeSessionId: string | null;
  monitorOpen: boolean;
  journalOpen: boolean;
  modelOverride: string;
  theme: string;
  onSelectAgent: (name: string) => void;
  onSelectSession: (id: string, agent: string) => void;
  onDeleteSession: (agent: string, id: string) => void;
  onNewSession: (agent: string) => void;
  onToggleMonitor: () => void;
  onToggleJournal: () => void;
  onModelChange: (model: string) => void;
  onHeaderClick: () => void;
  onThemeChange: (theme: string) => void;
}

const MODEL_SUGGESTIONS = [
  'xiaomi/mimo-v2-pro',
  'anthropic/claude-sonnet-4-5',
  'anthropic/claude-opus-4-5',
  'google/gemini-2.5-flash',
  'deepseek/deepseek-v3.2',
];

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms * 1000;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  const d = new Date(ms * 1000);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

interface SessionListProps {
  agent: AgentInfo;
  sessions: Session[];
  activeSessionId: string | null;
  onSelect: (id: string, agent: string) => void;
  onDelete: (agent: string, id: string) => void;
  onNew: (agent: string) => void;
}

function SessionList({ agent, sessions, activeSessionId, onSelect, onDelete, onNew }: SessionListProps) {
  const agentSessions = sessions
    .filter(s => s.agent === agent.name)
    .sort((a, b) => b.last_message_at - a.last_message_at);

  return (
    <div className="session-list">
      {agentSessions.map(s => (
        <div
          key={s.id}
          className={`session-item${activeSessionId === s.id ? ' active' : ''}`}
          onClick={() => onSelect(s.id, agent.name)}
        >
          <span className="session-item-time">
            {formatRelativeTime(s.last_message_at || s.created_at)}
          </span>
          <span className="session-item-title">
            {s.title || s.id.slice(0, 12)}
          </span>
          {s.last_input_tokens > 0 && (
            <span
              className="session-item-time"
              title={`${s.last_input_tokens} tokens`}
            >
              {formatTokens(s.last_input_tokens)}
            </span>
          )}
          <button
            className="session-item-delete"
            title="Delete session"
            onClick={e => { e.stopPropagation(); onDelete(agent.name, s.id); }}
          >
            ×
          </button>
        </div>
      ))}
      <button
        className="new-session-btn"
        onClick={() => onNew(agent.name)}
      >
        + new session
      </button>
    </div>
  );
}

export default function Sidebar({
  agents,
  sessions,
  activeAgent,
  activeSessionId,
  monitorOpen,
  journalOpen,
  modelOverride,
  theme,
  onSelectAgent,
  onSelectSession,
  onDeleteSession,
  onNewSession,
  onToggleMonitor,
  onToggleJournal,
  onModelChange,
  onHeaderClick,
  onThemeChange,
}: SidebarProps) {
  const sortedAgents = [...agents].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1 onClick={onHeaderClick}>chief</h1>
      </div>

      <div className="sidebar-content">
        {!monitorOpen ? (
          <>
            {sortedAgents.length > 0 && (
              <div className="sidebar-section">
                {sortedAgents.map(agent => (
                  <div key={agent.name}>
                    <button
                      className={`agent-btn${activeAgent === agent.name ? ' active' : ''}`}
                      onClick={() => onSelectAgent(agent.name)}
                      title={agent.description}
                    >
                      <span className="agent-indicator" />
                      <span className="agent-btn-name">{agent.title ?? agent.name}</span>
                    </button>
                    {activeAgent === agent.name && (
                      <SessionList
                        agent={agent}
                        sessions={sessions}
                        activeSessionId={activeSessionId}
                        onSelect={onSelectSession}
                        onDelete={onDeleteSession}
                        onNew={onNewSession}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          /* Monitor mode nav */
          <div className="sidebar-section">
            <div className="sidebar-section-label">Monitor</div>
            <button className="agent-btn" onClick={onHeaderClick}>
              <span>←</span>
              <span className="agent-btn-name">Back to Chat</span>
            </button>
            <div style={{ padding: '6px 14px', fontSize: 12, color: 'var(--text-muted)' }}>
              {agents.length} agent{agents.length !== 1 ? 's' : ''} active
            </div>
            {agents.map(a => (
              <div
                key={a.name}
                style={{ padding: '4px 14px', fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 6, alignItems: 'center' }}
              >
                <span className="agent-indicator" style={{ width: 6, height: 6 }} />
                <span>{a.title ?? a.name}</span>
                {a.effectiveModel && (
                  <span style={{ fontSize: 10, color: 'var(--text-light)', marginLeft: 'auto' }}>
                    {a.effectiveModel.split('/').pop()}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        <div className="theme-switcher">
          {THEMES.map(t => (
            <button
              key={t.id}
              className={`theme-dot${theme === t.id ? ' active' : ''}`}
              style={{ background: t.color }}
              title={t.label}
              onClick={() => onThemeChange(t.id)}
            />
          ))}
        </div>
        {!monitorOpen && (
          <div className="model-input-wrap">
            <label className="model-input-label" htmlFor="model-input">Model override</label>
            <input
              id="model-input"
              className="model-input"
              type="text"
              list="model-suggestions"
              value={modelOverride}
              onChange={e => onModelChange(e.target.value)}
              placeholder="default"
            />
            <datalist id="model-suggestions">
              {MODEL_SUGGESTIONS.map(m => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
        )}
        <button
          className={`monitor-btn${journalOpen ? ' active' : ''}`}
          onClick={onToggleJournal}
        >
          {journalOpen ? '← Back to Chat' : 'Journal'}
        </button>
        <button
          className={`monitor-btn${monitorOpen ? ' active' : ''}`}
          onClick={onToggleMonitor}
        >
          {monitorOpen ? '← Back to Chat' : 'Agent Monitor'}
        </button>
      </div>
    </aside>
  );
}
