'use client';

import { useState, useEffect } from 'react';
import { fetchAgentRuns, fetchTopics } from '@/lib/api';
import type { AgentInfo, AgentRun } from '@/lib/types';
import ChannelsPanel from './ChannelsPanel';
import TaskBoard from './TaskBoard';
import CcPanel from './CcPanel';

type Tab = 'runs' | 'topics' | 'tasks' | 'cc';

function AgentSidebar({ agents, selected, onSelect }: {
  agents: AgentInfo[];
  selected: string | null;
  onSelect: (name: string | null) => void;
}) {
  return (
    <div className="monitor-sidebar">
      <div className="monitor-sidebar-label">Agents</div>
      <div
        className={`monitor-sidebar-item${selected === null ? ' active' : ''}`}
        onClick={() => onSelect(null)}
      >
        All agents
      </div>
      {agents.map(a => (
        <div
          key={a.name}
          className={`monitor-sidebar-item${selected === a.name ? ' active' : ''}`}
          onClick={() => onSelect(a.name)}
        >
          {a.title ?? a.name}
        </div>
      ))}
    </div>
  );
}

interface AgentMonitorProps {
  agents: AgentInfo[];
  onClose?: () => void;
}

function formatRelativeTime(ts?: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function formatDuration(ms?: number): string {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function estimateCost(run: AgentRun): string {
  const inputTokens = run.inputTokens ?? 0;
  const outputTokens = run.outputTokens ?? 0;
  const cost = (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15;
  if (cost < 0.001) return '<$0.001';
  return `$${cost.toFixed(3)}`;
}

function modeBadgeClass(mode: string): string {
  const m = mode.toLowerCase().replace(/[^a-z_]/g, '_');
  const known = ['chat', 'heartbeat', 'self_eval', 'inter_agent_message', 'post_session'];
  return known.includes(m) ? m : 'default';
}

function RunCard({ run }: { run: AgentRun }) {
  const [expanded, setExpanded] = useState(false);
  const badgeClass = modeBadgeClass(run.mode);

  return (
    <div className="run-card">
      <div className="run-card-header" onClick={() => setExpanded(!expanded)}>
        <span className={`mode-badge ${badgeClass}`}>{run.mode}</span>
        <div className="run-card-meta">
          {run.inputTokens != null && <span>↑{run.inputTokens.toLocaleString()} in</span>}
          {run.outputTokens != null && <span>↓{run.outputTokens.toLocaleString()} out</span>}
          {(run.inputTokens != null || run.outputTokens != null) && <span>{estimateCost(run)}</span>}
          {run.durationMs != null && <span>{formatDuration(run.durationMs)}</span>}
          {run.turns != null && (() => {
            const count = Array.isArray(run.turns) ? run.turns.length : run.turns;
            return <span>{count} turn{count !== 1 ? 's' : ''}</span>;
          })()}
        </div>
        <span className="run-card-time">{formatRelativeTime(run.startedAt ?? run.completedAt)}</span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 4 }}>
          {expanded ? '▲' : '▼'}
        </span>
      </div>

      {expanded && (
        <div className="run-card-body">
          {run.model && (
            <div className="run-section">
              <div className="run-section-label">Model</div>
              <div style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--text-muted)' }}>{run.model}</div>
            </div>
          )}
          {(run.systemPrompt ?? run.prompt) && (
            <div className="run-section">
              <div className="run-section-label">System Prompt</div>
              <div className="run-section-content">{run.systemPrompt ?? run.prompt}</div>
            </div>
          )}
          {run.userMessage && (
            <div className="run-section">
              <div className="run-section-label">User Message</div>
              <div className="run-section-content">{run.userMessage}</div>
            </div>
          )}
          {run.result && (
            <div className="run-section">
              <div className="run-section-label">Result</div>
              <div className="run-section-content">
                {typeof run.result === 'string' ? run.result : JSON.stringify(run.result, null, 2)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RunsPanel({ agents, selectedAgent }: { agents: AgentInfo[]; selectedAgent: string | null }) {
  const [runsByAgent, setRunsByAgent] = useState<Record<string, AgentRun[]>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (agents.length === 0) return;
    setLoading(true);
    Promise.all(
      agents.map(a => fetchAgentRuns(a.name).then(runs => ({ name: a.name, runs })))
    ).then(results => {
      const map: Record<string, AgentRun[]> = {};
      results.forEach(r => { map[r.name] = r.runs; });
      setRunsByAgent(map);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [agents]);

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', padding: 16, fontSize: 13 }}>
      <span className="loading-spinner" /> Loading runs...
    </div>
  );

  const visibleAgents = selectedAgent ? agents.filter(a => a.name === selectedAgent) : agents;

  return (
    <div>
      {visibleAgents.map(agent => {
        const runs = runsByAgent[agent.name] ?? [];
        if (runs.length === 0) return null;
        return (
          <div key={agent.name} className="agent-runs-group">
            {runs.slice(0, 20).map((run, i) => (
              <RunCard key={run.id ?? i} run={run} />
            ))}
          </div>
        );
      })}
      {visibleAgents.every(a => (runsByAgent[a.name] ?? []).length === 0) && (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: 16 }}>No runs yet.</div>
      )}
    </div>
  );
}

function topicLabel(name: string) {
  if (name === 'feed') return 'feed';
  if (name.endsWith('_log')) return name.slice(0, -4).replace(/_/g, ' ') + ' log';
  return name.replace(/_/g, ' ');
}

function formatTopicTime(ts: string | null): string {
  if (!ts) return '';
  try {
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  } catch { return ''; }
}

export default function AgentMonitor({ agents, onClose }: AgentMonitorProps) {
  const [tab, setTab] = useState<Tab>('runs');
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [topics, setTopics] = useState<{ name: string; count: number; lastActivity: string | null }[]>([]);
  const [selectedTopic, setSelectedTopic] = useState<string>('feed');

  useEffect(() => {
    fetchTopics().then(setTopics).catch(() => setTopics([]));
  }, []);

  const tabLabel = (t: Tab) => {
    if (t === 'runs') return 'Runs';
    if (t === 'topics') return 'Topics';
    if (t === 'tasks') return 'Tasks';
    return 'Claude Code';
  };

  const hasSidebar = tab !== 'cc';

  return (
    <div className="monitor-overlay">
      <div className="monitor-header">
        {onClose && (
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 18, lineHeight: 1, padding: '0 4px', marginRight: 4 }} title="Back to chat">
            ←
          </button>
        )}
        <h2>Agent Monitor</h2>
        <div className="monitor-tabs">
          {(['runs', 'topics', 'tasks', 'cc'] as Tab[]).map(t => (
            <button
              key={t}
              className={`monitor-tab${tab === t ? ' active' : ''}`}
              onClick={() => setTab(t)}
            >
              {tabLabel(t)}
            </button>
          ))}
        </div>
      </div>

      <div className={`monitor-body${hasSidebar ? ' has-sidebar' : ''}`}>
        {/* Sidebar */}
        {(tab === 'runs' || tab === 'tasks') && (
          <AgentSidebar agents={agents} selected={selectedAgent} onSelect={setSelectedAgent} />
        )}

        {tab === 'topics' && (
          <div className="monitor-sidebar">
            <div className="monitor-sidebar-label">Topics</div>
            {topics.length === 0 && (
              <div style={{ padding: '6px 10px', fontSize: 12, color: 'var(--text-muted)' }}>No topics yet</div>
            )}
            {topics.map(t => (
              <div
                key={t.name}
                className={`monitor-sidebar-item${selectedTopic === t.name ? ' active' : ''}`}
                onClick={() => setSelectedTopic(t.name)}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                  <span>{topicLabel(t.name)}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--surface-hover)', borderRadius: 8, padding: '1px 5px' }}>
                    {t.count}
                  </span>
                </div>
                {t.lastActivity && (
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>
                    {formatTopicTime(t.lastActivity)}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Main content */}
        <div className="monitor-content">
          {tab === 'runs' && <RunsPanel agents={agents} selectedAgent={selectedAgent} />}
          {tab === 'topics' && <ChannelsPanel key={selectedTopic} topic={selectedTopic} />}
          {tab === 'tasks' && <TaskBoard selectedAgent={selectedAgent} />}
          {tab === 'cc' && <CcPanel />}
        </div>
      </div>
    </div>
  );
}
