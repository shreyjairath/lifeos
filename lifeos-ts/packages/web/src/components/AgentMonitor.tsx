'use client';

import { useState, useEffect } from 'react';
import { fetchAgentRuns } from '@/lib/api';
import type { AgentInfo, AgentRun } from '@/lib/types';
import ChannelsPanel from './ChannelsPanel';
import TaskBoard from './TaskBoard';
import CcPanel from './CcPanel';

type Tab = 'runs' | 'channels' | 'tasks' | 'cc';

interface AgentMonitorProps {
  agents: AgentInfo[];
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
  // approximate Sonnet pricing
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
          {run.inputTokens != null && (
            <span>↑{run.inputTokens.toLocaleString()} in</span>
          )}
          {run.outputTokens != null && (
            <span>↓{run.outputTokens.toLocaleString()} out</span>
          )}
          {(run.inputTokens != null || run.outputTokens != null) && (
            <span>{estimateCost(run)}</span>
          )}
          {run.durationMs != null && (
            <span>{formatDuration(run.durationMs)}</span>
          )}
          {run.turns != null && (
            <span>{run.turns} turn{run.turns !== 1 ? 's' : ''}</span>
          )}
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
              <div style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--text-muted)' }}>
                {run.model}
              </div>
            </div>
          )}
          {run.prompt && (
            <div className="run-section">
              <div className="run-section-label">Prompt (truncated)</div>
              <div className="run-section-content">{run.prompt.slice(0, 800)}{run.prompt.length > 800 ? '...' : ''}</div>
            </div>
          )}
          {run.result && (
            <div className="run-section">
              <div className="run-section-label">Result</div>
              <div className="run-section-content">{run.result.slice(0, 600)}{run.result.length > 600 ? '...' : ''}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RunsPanel({ agents }: { agents: AgentInfo[] }) {
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

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', padding: 8 }}>
        <span className="loading-spinner" /> Loading runs...
      </div>
    );
  }

  return (
    <div>
      {agents.map(agent => {
        const runs = runsByAgent[agent.name] ?? [];
        if (runs.length === 0) return null;
        return (
          <div key={agent.name} className="agent-runs-group">
            <div className="agent-runs-title">
              {agent.title ?? agent.name}
              <span className="runs-count">({runs.length} runs)</span>
            </div>
            {runs.slice(0, 20).map((run, i) => (
              <RunCard key={run.id ?? i} run={run} />
            ))}
          </div>
        );
      })}
      {agents.every(a => (runsByAgent[a.name] ?? []).length === 0) && (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No runs yet.</div>
      )}
    </div>
  );
}

export default function AgentMonitor({ agents }: AgentMonitorProps) {
  const [tab, setTab] = useState<Tab>('runs');

  return (
    <div className="monitor-overlay">
      <div className="monitor-header">
        <h2>Agent Monitor</h2>
        <div className="monitor-tabs">
          {(['runs', 'channels', 'tasks', 'cc'] as Tab[]).map(t => (
            <button
              key={t}
              className={`monitor-tab${tab === t ? ' active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t === 'runs' ? 'Runs' :
               t === 'channels' ? 'Channels' :
               t === 'tasks' ? 'Tasks' :
               'Claude Code'}
            </button>
          ))}
        </div>
      </div>

      <div className="monitor-content">
        {tab === 'runs' && <RunsPanel agents={agents} />}
        {tab === 'channels' && <ChannelsPanel />}
        {tab === 'tasks' && <TaskBoard />}
        {tab === 'cc' && <CcPanel />}
      </div>
    </div>
  );
}
