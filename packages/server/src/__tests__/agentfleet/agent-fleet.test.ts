import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { AgentFleet } from '../../agentfleet/agent-fleet.js';
import { AgentRegistry } from '../../agentfleet/agent-registry.js';
import { AgentRouter } from '../../agentfleet/agent-router.js';
import { EventBus } from '../../agentfleet/event-bus.js';
import { Confirmations } from '../../agent/executor/confirmations.js';
import { fakeAppConfig, fakeClientConfig, fakeAgent, fakeToolInvoker } from '../fakes.js';
import { makeTempDir, cleanupDir } from '../helpers.js';
import type { ToolsRegistry } from '../../agentfleet/tools-registry.js';
import type { SessionHandler } from '../../agent/session/session-handler.js';

let tmpDir: string;
let fleet: AgentFleet;
let eventBus: EventBus;

function makeFakeSession(): SessionHandler {
  return {
    createNew: () => 'sess-1',
    checkRotation: () => ({ shouldRotate: false, reason: '' }),
    getHistory: () => [],
    listSessions: () => [],
    clearSession: () => {},
    truncateSession: () => 0,
    pruneEmptySessions: () => {},
    checkExpiredSessions: () => {},
    delete: () => {},
    setLlmClientFactory: () => {},
  } as unknown as SessionHandler;
}

function makeFleet(agents: ReturnType<typeof fakeAgent>[] = []): AgentFleet {
  const map = new Map(agents.map((a) => [a.getName(), a]));
  const registry = {
    get: (name: string) => {
      const a = map.get(name);
      if (!a) throw new Error(`Agent '${name}' not found`);
      return a;
    },
    all: () => [...map.values()],
    register: () => { throw new Error('not implemented'); },
    load: () => {},
    identityText: () => '',
  } as unknown as AgentRegistry;

  const router = new AgentRouter(registry, eventBus);

  const fakeToolsRegistry = {
    getAgentsDir: () => tmpDir,
    topics: { getTopicsDir: () => `${tmpDir}/topics` },
    getScheduledTasks: () => ({
      getAllOverdue: () => [],
      upsert: () => ({ ok: true, id: 'task-1' }),
      markComplete: () => ({}),
    }),
    getGmailClient: () => null,
    allToolNames: () => ['bash', 'web_search'],
    loadDisabledTools: () => new Set<string>(),
    saveDisabledTools: () => {},
  } as unknown as ToolsRegistry;

  return new AgentFleet(
    registry,
    eventBus,
    router,
    fakeAppConfig(),
    fakeClientConfig(),
    fakeToolsRegistry,
    new Confirmations(),
  );
}

beforeEach(() => {
  tmpDir = makeTempDir('agent-fleet');
  eventBus = new EventBus();
});

afterEach(() => {
  cleanupDir(tmpDir);
});

describe('AgentFleet getters', () => {
  it('getEventBus returns the event bus', () => {
    fleet = makeFleet();
    expect(fleet.getEventBus()).toBe(eventBus);
  });

  it('getAgentsDir returns agents dir', () => {
    fleet = makeFleet();
    expect(fleet.getAgentsDir()).toBe(tmpDir);
  });

  it('getTopicsDir returns topics dir', () => {
    fleet = makeFleet();
    expect(fleet.getTopicsDir()).toContain('topics');
  });
});

describe('AgentFleet.allAgents', () => {
  it('returns all agents', () => {
    const cos = fakeAgent({ getName: () => 'cos' });
    fleet = makeFleet([cos]);
    expect(fleet.allAgents()).toHaveLength(1);
  });
});

describe('AgentFleet.agentInfo', () => {
  it('returns agent info', () => {
    const { fakeAgentDefinition } = require('../fakes.js');
    const def = fakeAgentDefinition({ name: 'cos', title: 'CoS' });
    const cos = fakeAgent({ getName: () => 'cos', getTitle: () => 'CoS', getDefinition: () => def });
    fleet = makeFleet([cos]);
    const info = fleet.agentInfo('cos');
    expect(info.name).toBe('cos');
    expect(info.title).toBe('CoS');
  });
});

describe('AgentFleet session methods', () => {
  it('createSession delegates to agent session handler', () => {
    const session = makeFakeSession();
    const cos = fakeAgent({ getName: () => 'cos', getSessionHandler: () => session });
    fleet = makeFleet([cos]);
    const id = fleet.createSession('cos');
    expect(id).toBe('sess-1');
  });

  it('listSessions delegates to agent session handler', () => {
    const session = { ...makeFakeSession(), listSessions: () => [{ id: 'sess-1' }] };
    const cos = fakeAgent({ getName: () => 'cos', getSessionHandler: () => session as any });
    fleet = makeFleet([cos]);
    expect(fleet.listSessions('cos')).toHaveLength(1);
  });

  it('listAllSessions aggregates from all agents', () => {
    const s1 = { ...makeFakeSession(), listSessions: () => [{ id: 's1' }] };
    const s2 = { ...makeFakeSession(), listSessions: () => [{ id: 's2' }] };
    const cos = fakeAgent({ getName: () => 'cos', getSessionHandler: () => s1 as any });
    const other = fakeAgent({ getName: () => 'other', getSessionHandler: () => s2 as any });
    fleet = makeFleet([cos, other]);
    expect(fleet.listAllSessions()).toHaveLength(2);
  });

  it('cancel delegates to agent', () => {
    let cancelled = false;
    const cos = fakeAgent({ getName: () => 'cos', cancel: () => { cancelled = true; } });
    fleet = makeFleet([cos]);
    fleet.cancel('cos', 'sess-1');
    expect(cancelled).toBe(true);
  });
});

describe('AgentFleet.trigger', () => {
  it('publishes event to event bus without throwing', () => {
    fleet = makeFleet();
    expect(() => fleet.trigger('test_event')).not.toThrow();
    expect(() => fleet.trigger('heartbeat_trigger', { agent: 'cos' })).not.toThrow();
  });
});

describe('AgentFleet.triggerTaskCheck', () => {
  it('does nothing when no overdue tasks', async () => {
    fleet = makeFleet();
    await expect(fleet.triggerTaskCheck()).resolves.toBeUndefined();
  });

  it('calls markAllComplete (not markComplete) after a task run — platform tasks must be completable', async () => {
    const markCompleteCalls: string[] = [];
    const markAllCompleteCalls: string[][] = [];

    let resolveTask: () => void;
    const taskDone = new Promise<void>((res) => { resolveTask = res; });

    const cos = fakeAgent({
      getName: () => 'cos',
      handleOverdueTask: (_task: any, onComplete: () => void) => {
        // Simulate async completion
        Promise.resolve().then(() => { onComplete(); resolveTask(); });
      },
    });

    const map = new Map([['cos', cos]]);
    const registry = {
      get: (name: string) => { const a = map.get(name); if (!a) throw new Error(`not found: ${name}`); return a; },
      all: () => [...map.values()],
      register: () => {},
      load: () => {},
      identityText: () => '',
    } as unknown as import('../../agentfleet/agent-registry.js').AgentRegistry;

    const router = new AgentRouter(registry, eventBus);

    const fakeToolsRegistry = {
      getAgentsDir: () => tmpDir,
      topics: { getTopicsDir: () => `${tmpDir}/topics` },
      getScheduledTasks: () => ({
        getAllOverdue: () => [{ id: 'task-1', name: 'reconcile_workspace', assignee: 'cos', platform: true }],
        upsert: () => ({ ok: true }),
        markComplete: (id: string) => { markCompleteCalls.push(id); return {}; },
        markAllComplete: (ids: string[]) => { markAllCompleteCalls.push(ids); },
      }),
      getGmailClient: () => null,
      allToolNames: () => [],
      loadDisabledTools: () => new Set<string>(),
      saveDisabledTools: () => {},
    } as unknown as import('../../agentfleet/tools-registry.js').ToolsRegistry;

    const f = new AgentFleet(registry, eventBus, router, fakeAppConfig(), fakeClientConfig(), fakeToolsRegistry, new Confirmations());
    f.triggerTaskCheck();
    await taskDone;

    expect(markCompleteCalls).toHaveLength(0);
    expect(markAllCompleteCalls).toHaveLength(1);
    expect(markAllCompleteCalls[0]).toContain('task-1');
  });
});

describe('AgentFleet tools management', () => {
  it('getAllToolsInfo returns tools and disabled lists', () => {
    fleet = makeFleet();
    const info = fleet.getAllToolsInfo();
    expect(Array.isArray(info.tools)).toBe(true);
    expect(Array.isArray(info.disabled)).toBe(true);
  });

  it('getDisabledTools returns empty array by default', () => {
    fleet = makeFleet();
    expect(fleet.getDisabledTools()).toEqual([]);
  });

  it('setDisabledTools delegates to toolsRegistry', () => {
    let saved: Set<string> | null = null;
    const savedRegistry = {
      getAgentsDir: () => tmpDir,
      topics: { getTopicsDir: () => `${tmpDir}/topics` },
      getScheduledTasks: () => ({ getAllOverdue: () => [], upsert: () => ({}), markComplete: () => ({}) }),
      getGmailClient: () => null,
      allToolNames: () => [],
      loadDisabledTools: () => new Set<string>(),
      saveDisabledTools: (s: Set<string>) => { saved = s; },
    } as unknown as ToolsRegistry;
    const registry = { get: () => { throw new Error(); }, all: () => [], load: () => {} } as unknown as AgentRegistry;
    const f = new AgentFleet(registry, eventBus, new AgentRouter(registry, eventBus), fakeAppConfig(), fakeClientConfig(), savedRegistry, new Confirmations());
    f.setDisabledTools(['bash']);
    expect(saved).not.toBeNull();
    expect([...saved!]).toContain('bash');
  });
});
