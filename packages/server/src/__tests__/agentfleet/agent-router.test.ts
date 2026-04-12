import { describe, it, expect } from 'bun:test';
import { AgentRouter } from '../../agentfleet/agent-router.js';
import { EventBus } from '../../agentfleet/event-bus.js';
import { fakeAgent, fakeAgentDefinition } from '../fakes.js';
import type { AgentRegistry } from '../../agentfleet/agent-registry.js';
import type { SessionHandler } from '../../agent/session/session-handler.js';

function makeRegistry(agents: ReturnType<typeof fakeAgent>[]): AgentRegistry {
  const map = new Map(agents.map((a) => [a.getName(), a]));
  return {
    get: (name: string) => {
      const a = map.get(name);
      if (a) return a;
      const first = map.values().next().value;
      if (!first) throw new Error('No agents loaded');
      return first;
    },
    all: () => [...map.values()],
    register: () => { throw new Error('not implemented'); },
    load: () => {},
    identityText: () => '',
  } as unknown as AgentRegistry;
}

// Minimal fake session handler
function makeFakeSession(sessionId = 'sess-1'): SessionHandler {
  return {
    createNew: (_name: string) => sessionId,
    checkRotation: () => ({ shouldRotate: false, reason: '' }),
    rotate: () => 'sess-2',
    getHistory: () => [],
    appendMessage: () => {},
    listSessions: () => [],
    clearSession: () => {},
    pruneEmptySessions: () => {},
    updateSessionMeta: () => {},
    getSessionMeta: () => ({}),
    getParentSummary: () => null,
    checkExpiredSessions: () => {},
    delete: () => {},
    truncateSession: () => 0,
    getDisplayHistory: () => ({ messages: [], total: 0, session_id: sessionId }),
    writeSummary: () => {},
    readSummary: () => '',
    setLlmClientFactory: () => {},
  } as unknown as SessionHandler;
}

describe('AgentRouter.handleMessage', () => {
  it('auto-creates session and yields session_id frame', async () => {
    const session = makeFakeSession();
    const cos = fakeAgent({
      getName: () => 'cos',
      getSessionHandler: () => session,
      handleUserMessage: async function* () {
        yield { type: 'llm_text', text: 'hello' } as any;
      },
    });
    const registry = makeRegistry([cos]);
    const router = new AgentRouter(registry, new EventBus());
    const frames: any[] = [];
    for await (const f of router.handleMessage(undefined, 'hi', 'cos')) {
      frames.push(JSON.parse(f.data));
    }
    expect(frames.some((f) => f.type === 'session_id')).toBe(true);
    expect(frames.some((f) => f.type === 'done')).toBe(true);
  });

  it('yields done frame on normal completion', async () => {
    const session = makeFakeSession('existing-sess');
    const cos = fakeAgent({
      getName: () => 'cos',
      getSessionHandler: () => session,
      handleUserMessage: async function* () {
        yield { type: 'llm_text', text: 'response' } as any;
      },
    });
    const registry = makeRegistry([cos]);
    const router = new AgentRouter(registry, new EventBus());
    const frames: any[] = [];
    for await (const f of router.handleMessage('existing-sess', 'hello', 'cos')) {
      frames.push(JSON.parse(f.data));
    }
    expect(frames[frames.length - 1].type).toBe('done');
  });

  it('yields session_rotating frame when rotation needed', async () => {
    const session = {
      ...makeFakeSession(),
      checkRotation: () => ({ shouldRotate: true, reason: '50k tokens' }),
    } as unknown as SessionHandler;
    const cos = fakeAgent({
      getName: () => 'cos',
      getSessionHandler: () => session,
      handleUserMessage: async function* () {},
    });
    const registry = makeRegistry([cos]);
    const router = new AgentRouter(registry, new EventBus());
    const frames: any[] = [];
    for await (const f of router.handleMessage('old-sess', 'hi', 'cos')) {
      frames.push(JSON.parse(f.data));
    }
    expect(frames.some((f) => f.type === 'session_rotating')).toBe(true);
    expect(frames.some((f) => f.type === 'session_rotated')).toBe(true);
  });

  it('yields stopped frame on tool_cancelled', async () => {
    const session = makeFakeSession('sess-1');
    const cos = fakeAgent({
      getName: () => 'cos',
      getSessionHandler: () => session,
      handleUserMessage: async function* () {
        yield { type: 'tool_cancelled' } as any;
      },
    });
    const registry = makeRegistry([cos]);
    const router = new AgentRouter(registry, new EventBus());
    const frames: any[] = [];
    for await (const f of router.handleMessage('sess-1', 'hi', 'cos')) {
      frames.push(JSON.parse(f.data));
    }
    expect(frames[frames.length - 1].type).toBe('stopped');
  });

  it('yields error frame on thrown exception', async () => {
    const session = makeFakeSession('sess-1');
    const cos = fakeAgent({
      getName: () => 'cos',
      getSessionHandler: () => session,
      handleUserMessage: async function* () {
        throw new Error('agent blew up');
      },
    });
    const registry = makeRegistry([cos]);
    const router = new AgentRouter(registry, new EventBus());
    const frames: any[] = [];
    for await (const f of router.handleMessage('sess-1', 'hi', 'cos')) {
      frames.push(JSON.parse(f.data));
    }
    expect(frames.some((f) => f.type === 'error')).toBe(true);
    expect(frames.find((f) => f.type === 'error').text).toContain('agent blew up');
  });

  it('serializes llm_text events', async () => {
    const session = makeFakeSession('sess-1');
    const cos = fakeAgent({
      getName: () => 'cos',
      getSessionHandler: () => session,
      handleUserMessage: async function* () {
        yield { type: 'llm_text', text: 'Hello world' } as any;
      },
    });
    const registry = makeRegistry([cos]);
    const router = new AgentRouter(registry, new EventBus());
    const frames: any[] = [];
    for await (const f of router.handleMessage('sess-1', 'hi', 'cos')) {
      frames.push(JSON.parse(f.data));
    }
    const textFrame = frames.find((f) => f.type === 'llm_text');
    expect(textFrame).toBeDefined();
    expect(textFrame.text).toBe('Hello world');
  });
});
