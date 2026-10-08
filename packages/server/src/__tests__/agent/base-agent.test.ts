import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { BaseAgent, buildSystemPrompt } from '../../agent/base-agent.js';
import { SessionHandler } from '../../agent/session/session-handler.js';
import { SessionStore } from '../../agent/session/session-store.js';
import { EmailThreadStore } from '../../agentfleet/tools/email-thread-store.js';
import { EventBus } from '../../agentfleet/event-bus.js';
import { Confirmations } from '../../agent/executor/confirmations.js';
import { Executor } from '../../agent/executor/executor.js';
import type { LlmClient } from '../../agent/executor/llm-client.js';
import { makeTempDir, cleanupDir } from '../helpers.js';
import { fakeAppConfig, fakeClientConfig, fakeAgentDefinition, fakeToolInvoker } from '../fakes.js';

let tmpDir: string;
let agentsDir: string;
let agent: BaseAgent;
let eventBus: EventBus;

// Fake executor factory — yields a configurable set of events
function makeExecutorFactory(textResponse = 'I am the response'): (llm: LlmClient, conf: Confirmations) => Executor {
  return (_llm, _conf) => {
    const exec = new Executor(_llm, _conf);
    // Override runLoop to yield synthetic events
    exec.runLoop = async function* () {
      yield { type: 'llm_request', model: 'test-model', maxTokens: 4096, system: '', messages: [], tools: [] };
      yield { type: 'llm_text', text: textResponse };
      yield { type: 'llm_response', stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: textResponse }] };
      yield { type: 'agent_append', role: 'assistant', message: { role: 'assistant', content: textResponse } };
    };
    return exec;
  };
}

function makeAgent(textResponse = 'hello'): BaseAgent {
  const def = fakeAgentDefinition({ name: 'cos', title: 'CoS' });
  const config = fakeAppConfig();
  const clientConfig = fakeClientConfig();
  const store = new SessionStore(agentsDir, 'cos');
  const session = new SessionHandler(config, store, 'cos');
  const emailStore = new EmailThreadStore(agentsDir, 'cos');
  return new BaseAgent(
    def,
    fakeToolInvoker(),
    new Confirmations(),
    config,
    clientConfig,
    agentsDir,
    eventBus,
    () => [],
    session,
    emailStore,
    makeExecutorFactory(textResponse),
  );
}

beforeEach(() => {
  tmpDir = makeTempDir('base-agent');
  agentsDir = tmpDir;
  eventBus = new EventBus();
  agent = makeAgent();
});

afterEach(() => {
  cleanupDir(tmpDir);
});

// ── Getters ───────────────────────────────────────────────────────────────────

describe('BaseAgent getters', () => {
  it('getName returns def.name', () => expect(agent.getName()).toBe('cos'));
  it('getTitle returns def.title', () => expect(agent.getTitle()).toBe('CoS'));
  it('getDescription returns def.description', () => expect(agent.getDescription()).toBeDefined());
  it('getDefinition returns the definition', () => expect(agent.getDefinition().name).toBe('cos'));
  it('getWorkspaceDir contains agent name', () => expect(agent.getWorkspaceDir()).toContain('cos'));
  it('getSessionHandler returns session handler', () => expect(agent.getSessionHandler()).toBeDefined());
});

// ── cancel ────────────────────────────────────────────────────────────────────

describe('BaseAgent.cancel', () => {
  it('does not throw for unknown sessionId', () => {
    expect(() => agent.cancel('nonexistent-session')).not.toThrow();
  });
});

// ── handleUserMessage ─────────────────────────────────────────────────────────

describe('BaseAgent.handleUserMessage', () => {
  it('yields events and persists messages', async () => {
    const sessionId = agent.session.createNew('cos');
    const events: any[] = [];
    for await (const e of agent.handleUserMessage(sessionId, 'hello')) {
      events.push(e);
    }
    expect(events.some((e) => e.type === 'llm_text')).toBe(true);
    // Messages should be persisted
    const history = agent.session.getHistory(sessionId);
    expect(history.some((m) => m.role === 'user')).toBe(true);
  });

  it('saves a run record', async () => {
    const sessionId = agent.session.createNew('cos');
    for await (const _ of agent.handleUserMessage(sessionId, 'test')) {}
    const { getRecentRuns } = await import('../../agent/agent-run-logs.js');
    const runs = getRecentRuns('cos', agentsDir);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].agent).toBe('cos');
  });
});

// ── handleAgentMessage ────────────────────────────────────────────────────────

describe('BaseAgent.handleAgentMessage', () => {
  it('returns response text', async () => {
    const a = makeAgent('Response from agent');
    const resp = await a.handleAgentMessage('other', 'what should I do?');
    expect(resp).toBe('Response from agent');
  });
});

// ── handleAgentMessageAsync ───────────────────────────────────────────────────

describe('BaseAgent.handleAgentMessageAsync', () => {
  it('does not throw and calls onComplete callback', async () => {
    let called = false;
    agent.handleAgentMessageAsync('other', 'hello', (response) => {
      called = true;
      expect(typeof response).toBe('string');
    });
    // Give background queue time to run
    await new Promise((r) => setTimeout(r, 50));
    expect(called).toBe(true);
  });
});

// ── handleEmailCheck / handleOverdueTask ──────────────────────────────────────

describe('BaseAgent.handleEmailCheck', () => {
  it('does not throw with empty threads', () => {
    expect(() => agent.handleEmailCheck([])).not.toThrow();
  });

  it('does not throw with populated threads', () => {
    expect(() => agent.handleEmailCheck([{
      threadId: 'thread-1',
      messageIds: ['msg-1', 'msg-2'],
      latestRfcMessageId: '<abc@mail.gmail.com>',
      latestFrom: 'alice@example.com',
      latestTo: 'mailbox@example.com',
      latestCc: 'bob@example.com',
      subject: 'Hello',
    }])).not.toThrow();
  });

  it('enqueues context containing thread_id, in_reply_to, from, to, cc', async () => {
    let captured = '';
    (agent as any).handleSystemMessage = async (_mode: string, msg: string) => { captured = msg; };

    agent.handleEmailCheck([{
      threadId: 'thread-abc',
      messageIds: ['msg-1'],
      latestRfcMessageId: '<abc@mail.gmail.com>',
      latestFrom: 'alice@example.com',
      latestTo: 'mailbox@example.com',
      latestCc: 'carol@example.com',
      subject: 'Test',
    }]);

    // drain the background queue
    await new Promise((r) => setTimeout(r, 50));

    expect(captured).toContain('thread-abc');
    expect(captured).toContain('<abc@mail.gmail.com>');
    expect(captured).toContain('alice@example.com');
    expect(captured).toContain('mailbox@example.com');
    expect(captured).toContain('carol@example.com');
  });

  it('omits cc line when latestCc is empty', async () => {
    let captured = '';
    (agent as any).handleSystemMessage = async (_mode: string, msg: string) => { captured = msg; };

    agent.handleEmailCheck([{
      threadId: 'thread-xyz',
      messageIds: ['msg-1'],
      latestRfcMessageId: '<xyz@mail.gmail.com>',
      latestFrom: 'sender@example.com',
      latestTo: 'mailbox@example.com',
      latestCc: '',
      subject: 'No CC',
    }]);

    await new Promise((r) => setTimeout(r, 50));

    expect(captured).toContain('thread-xyz');
    expect(captured).not.toContain('**cc:**');
  });
});

describe('BaseAgent.handleOverdueTask', () => {
  it('does not throw', () => {
    expect(() => agent.handleOverdueTask({ name: 'review', description: 'Do a review' })).not.toThrow();
  });
});

// ── buildSystemPrompt (exported) ──────────────────────────────────────────────

describe('buildSystemPrompt', () => {
  const def = fakeAgentDefinition({ name: 'cos', title: 'CoS', manager: null });
  const clientConfig = fakeClientConfig();

  it('includes agent name in identity block', () => {
    const prompt = buildSystemPrompt(def, clientConfig, [], 'chat', { identityText: '' });
    expect(prompt).toContain('Your name is **cos**');
  });

  it('includes manager if set', () => {
    const defWithManager = fakeAgentDefinition({ name: 'therapist', manager: 'cos' });
    const prompt = buildSystemPrompt(defWithManager, clientConfig, [], 'chat', { identityText: '' });
    expect(prompt).toContain('Your manager is **cos**');
  });

  it('includes hires', () => {
    const prompt = buildSystemPrompt(def, clientConfig, ['therapist', 'other'], 'chat', { identityText: '' });
    expect(prompt).toContain('**therapist**');
    expect(prompt).toContain('**other**');
  });

  it('chat mode includes session ID', () => {
    const prompt = buildSystemPrompt(def, clientConfig, [], 'chat', { sessionId: 'sess-123', identityText: '' });
    expect(prompt).toContain('sess-123');
  });

  it('inter-agent-message mode includes sync/async callout', () => {
    const sync = buildSystemPrompt(def, clientConfig, [], 'inter-agent-message', { async: false, identityText: '' });
    expect(sync).toContain('Sync message');
    const async_ = buildSystemPrompt(def, clientConfig, [], 'inter-agent-message', { async: true, identityText: '' });
    expect(async_).toContain('Async message');
  });

  it('includes client name and timezone', () => {
    const prompt = buildSystemPrompt(def, clientConfig, [], 'chat', { identityText: '' });
    expect(prompt).toContain('Test User');
    expect(prompt).toContain('America/New_York');
  });

  it('includes goal when set', () => {
    const defWithGoal = fakeAgentDefinition({ goal: 'Help the user be their best self.' });
    const prompt = buildSystemPrompt(defWithGoal, clientConfig, [], 'chat', { identityText: '' });
    expect(prompt).toContain('Help the user be their best self.');
  });

  it('includes parent summary in chat mode', () => {
    const prompt = buildSystemPrompt(def, clientConfig, [], 'chat', {
      sessionId: 'sess-1',
      parentSummary: { content: 'Previous session summary content', dateStr: 'Jan 01, 2024' },
      identityText: '',
    });
    expect(prompt).toContain('Previous session summary content');
    expect(prompt).toContain('Jan 01, 2024');
  });

  it('throws for unknown mode', () => {
    expect(() => buildSystemPrompt(def, clientConfig, [], 'unknown_mode', {})).toThrow('Unknown system mode');
  });
});
