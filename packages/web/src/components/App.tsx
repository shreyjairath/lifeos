'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Sidebar from './Sidebar';
import ChatPanel from './ChatPanel';
import ArtifactPanel from './ArtifactPanel';
import AgentMonitor from './AgentMonitor';
import JournalPanel from './JournalPanel';
import {
  fetchAgents,
  fetchSessions,
  createSession,
  deleteSession,
  fetchVapidPublicKey,
  subscribePush,
  urlBase64ToUint8Array,
  getApiBase,
} from '@/lib/api';
import type { AgentInfo, Session, Toast, GlobalEvent } from '@/lib/types';

const AGENT_KEY = 'chief-agent';
const MODEL_KEY = 'chief-model';
const THEME_KEY = 'chief-theme';

function sessionKey(agent: string) {
  return `chief-session-${agent}`;
}

function nanoid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function App() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeAgent, setActiveAgent] = useState<string>('cos');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [journalOpen, setJournalOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [artifactOpen, setArtifactOpen] = useState(false);
  const [artifactUrl, setArtifactUrl] = useState<string | null>(null);
  const [artifactTitle, setArtifactTitle] = useState('');
  const [modelOverride, setModelOverride] = useState('');
  const [theme, setThemeState] = useState<string>('forest');
  const [notifications, setNotifications] = useState<Toast[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);
  const toastTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Load persisted state
  useEffect(() => {
    const savedAgent = localStorage.getItem(AGENT_KEY);
    if (savedAgent) setActiveAgent(savedAgent);
    const savedModel = localStorage.getItem(MODEL_KEY);
    if (savedModel) setModelOverride(savedModel);
    const savedTheme = localStorage.getItem(THEME_KEY);
    if (savedTheme) setThemeState(savedTheme);
  }, []);

  // Fetch agents
  useEffect(() => {
    fetchAgents()
      .then(a => {
        setAgents(a);
        // Restore session for the active agent
        const agent = localStorage.getItem(AGENT_KEY) ?? 'cos';
        const sid = localStorage.getItem(sessionKey(agent));
        if (sid) setSessionId(sid);
      })
      .catch(console.error);
  }, []);

  // Fetch sessions
  const refreshSessions = useCallback(() => {
    fetchSessions().then(setSessions).catch(console.error);
  }, []);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  // Global event bus SSE
  useEffect(() => {
    const es = new EventSource(`${getApiBase()}/api/events`);
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      try {
        const event: GlobalEvent = JSON.parse(e.data);
        handleGlobalEvent(event);
      } catch { /* ignore */ }
    };

    es.addEventListener('notification', (e: MessageEvent) => {
      try {
        const event: GlobalEvent = JSON.parse(e.data);
        handleGlobalEvent(event);
      } catch { /* ignore */ }
    });

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleGlobalEvent = (event: GlobalEvent) => {
    if (event.type === 'notification') {
      addToast({
        id: nanoid(),
        agent: event.agent,
        agentTitle: event.agentTitle,
        message: event.message,
        urgency: event.urgency,
        context: event.context,
      });
    } else if (event.type === 'reminder') {
      addToast({
        id: nanoid(),
        agent: 'system',
        agentTitle: 'Reminder',
        message: event.message,
        urgency: 'medium',
      });
    } else if (event.type === 'agents_updated') {
      fetchAgents().then(setAgents).catch(console.error);
    } else if (event.type === 'artifact_updated') {
      setArtifactUrl(event.url);
      setArtifactTitle(event.title);
    }
  };

  const addToast = (toast: Toast) => {
    setNotifications(prev => [...prev, toast]);
    const timer = setTimeout(() => {
      dismissToast(toast.id);
    }, 8000);
    toastTimers.current.set(toast.id, timer);
  };

  const dismissToast = (id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
    const t = toastTimers.current.get(id);
    if (t) {
      clearTimeout(t);
      toastTimers.current.delete(id);
    }
  };

  // Web Push setup
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker
      .register('/sw.js')
      .then(async () => {
        const publicKey = await fetchVapidPublicKey();
        if (!publicKey) return;
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') return;
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
          sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
          });
        }
        await subscribePush(sub);
      })
      .catch(() => { /* ignore push errors */ });
  }, []);

  // Handlers
  const handleSelectAgent = (name: string) => {
    setActiveAgent(name);
    localStorage.setItem(AGENT_KEY, name);
    const sid = localStorage.getItem(sessionKey(name));
    setSessionId(sid ?? null);
    setMonitorOpen(false);
    setSidebarOpen(false);
  };

  const handleSelectSession = (id: string, agent: string) => {
    setActiveAgent(agent);
    localStorage.setItem(AGENT_KEY, agent);
    setSessionId(id);
    localStorage.setItem(sessionKey(agent), id);
    setMonitorOpen(false);
    setSidebarOpen(false);
  };

  const handleDeleteSession = async (agent: string, id: string) => {
    await deleteSession(agent, id).catch(console.error);
    if (sessionId === id) {
      setSessionId(null);
      localStorage.removeItem(sessionKey(agent));
    }
    refreshSessions();
  };

  const handleNewSession = async (agent: string) => {
    try {
      const newId = await createSession(agent);
      setActiveAgent(agent);
      localStorage.setItem(AGENT_KEY, agent);
      setSessionId(newId);
      localStorage.setItem(sessionKey(agent), newId);
      setMonitorOpen(false);
      setSidebarOpen(false);
      refreshSessions();
    } catch (e) {
      console.error('Failed to create session', e);
    }
  };

  const handleSessionCreated = (newId: string) => {
    setSessionId(newId);
    localStorage.setItem(sessionKey(activeAgent), newId);
    refreshSessions();
  };

  const handleSessionRotated = (newId: string) => {
    setSessionId(newId);
    localStorage.setItem(sessionKey(activeAgent), newId);
    refreshSessions();
  };

  const handleModelChange = (m: string) => {
    setModelOverride(m);
    localStorage.setItem(MODEL_KEY, m);
  };

  const handleThemeChange = (t: string) => {
    setThemeState(t);
    localStorage.setItem(THEME_KEY, t);
  };

  const handleToggleMonitor = () => {
    setMonitorOpen(v => !v);
    setJournalOpen(false);
  };

  const handleToggleJournal = () => {
    setJournalOpen(v => !v);
    setMonitorOpen(false);
  };

  const handleHeaderClick = () => {
    if (monitorOpen) setMonitorOpen(false);
    if (journalOpen) setJournalOpen(false);
    setSidebarOpen(false);
  };

  const activeAgentInfo = agents.find(a => a.name === activeAgent);

  return (
    <div className="app-layout" data-theme={theme}>
      {/* Mobile header */}
      <div className="mobile-header">
        <button className="hamburger-btn" onClick={() => setSidebarOpen(true)}>☰</button>
        <h1>{activeAgentInfo?.title ?? activeAgentInfo?.name ?? 'chief'}</h1>
        <button className="mobile-new-btn" onClick={() => setArtifactOpen(v => !v)}>📄</button>
      </div>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="sidebar-overlay open"
          onClick={(e) => { if (e.target === e.currentTarget) setSidebarOpen(false); }}
        >
          <Sidebar
            agents={agents}
            sessions={sessions}
            activeAgent={activeAgent}
            activeSessionId={sessionId}
            monitorOpen={monitorOpen}
            journalOpen={journalOpen}
            modelOverride={modelOverride}
            onSelectAgent={handleSelectAgent}
            onSelectSession={handleSelectSession}
            onDeleteSession={handleDeleteSession}
            onNewSession={handleNewSession}
            onToggleMonitor={handleToggleMonitor}
            onToggleJournal={handleToggleJournal}
            onModelChange={handleModelChange}
            onHeaderClick={handleHeaderClick}
            theme={theme}
            onThemeChange={handleThemeChange}
          />
        </div>
      )}

      {/* Desktop sidebar */}
      {!monitorOpen && (
        <Sidebar
          agents={agents}
          sessions={sessions}
          activeAgent={activeAgent}
          activeSessionId={sessionId}
          monitorOpen={monitorOpen}
          journalOpen={journalOpen}
          modelOverride={modelOverride}
          onSelectAgent={handleSelectAgent}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
          onNewSession={handleNewSession}
          onToggleMonitor={handleToggleMonitor}
          onToggleJournal={handleToggleJournal}
          onModelChange={handleModelChange}
          onHeaderClick={handleHeaderClick}
          theme={theme}
          onThemeChange={handleThemeChange}
        />
      )}

      {/* Main content area */}
      <div className="main-area">
        {monitorOpen ? (
          <AgentMonitor agents={agents} onClose={() => setMonitorOpen(false)} />
        ) : journalOpen ? (
          <JournalPanel />
        ) : (
          <ChatPanel
            agent={activeAgentInfo}
            sessionId={sessionId}
            modelOverride={modelOverride}
            artifactOpen={artifactOpen}
            onSessionCreated={handleSessionCreated}
            onSessionRotated={handleSessionRotated}
            onOpenArtifact={(url, title) => { setArtifactUrl(url); setArtifactTitle(title); setArtifactOpen(true); }}
            onToggleArtifacts={() => setArtifactOpen(v => !v)}
          />
        )}
      </div>

      {/* Artifact panel */}
      <ArtifactPanel
        open={artifactOpen}
        url={artifactUrl}
        title={artifactTitle}
        agent={activeAgent}
        onClose={() => { setArtifactOpen(false); setArtifactUrl(null); setArtifactTitle(''); }}
      />

      {/* Notification tray */}
      <div className="notifications-tray">
        {notifications.map(n => (
          <div key={n.id} className={`toast ${n.urgency}`}>
            <div className="toast-header">
              <span className="toast-agent">{n.agentTitle}</span>
              <span className="toast-urgency">{n.urgency}</span>
              <button className="toast-close" onClick={() => dismissToast(n.id)}>×</button>
            </div>
            <div className="toast-message">{n.message}</div>
            {n.context && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                {n.context}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
