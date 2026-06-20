import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import yaml from 'js-yaml';
import { AgentTools } from '../../../agentfleet/tools/agent-tools.js';
import { AgentTopics } from '../../../agentfleet/tools/agent-topics.js';
import { EventBus } from '../../../agentfleet/event-bus.js';
import { makeTempDir, cleanupDir } from '../../helpers.js';
import { fakeAgentDefinition, fakeAgent } from '../../fakes.js';
import type { AgentRegistry } from '../../../agentfleet/agent-registry.js';

let tmpDir: string;
let agentsDir: string;
let topics: AgentTopics;
let eventBus: EventBus;
let agentTools: AgentTools;

function makeRegistry(agents: ReturnType<typeof fakeAgent>[]): AgentRegistry {
  const map = new Map(agents.map((a) => [a.getName(), a]));
  return {
    get: (name: string) => map.get(name) ?? null,
    all: () => [...map.values()],
    register: () => fakeAgent() as any,
    load: () => {},
    identityText: () => '',
  } as unknown as AgentRegistry;
}

beforeEach(() => {
  tmpDir = makeTempDir('agent-tools');
  agentsDir = resolve(tmpDir, 'agents');
  mkdirSync(agentsDir, { recursive: true });
  topics = new AgentTopics(resolve(tmpDir, 'topics'));
  eventBus = new EventBus();
});

afterEach(() => {
  cleanupDir(tmpDir);
});

// ── listAgents ────────────────────────────────────────────────────────────────

describe('AgentTools.listAgents', () => {
  it('lists all agents', () => {
    const registry = makeRegistry([
      fakeAgent({ getName: () => 'cos', getTitle: () => 'CoS', getDescription: () => 'Chief of Staff' }),
      fakeAgent({ getName: () => 'therapist', getTitle: () => 'Therapist', getDescription: () => 'Therapy agent' }),
    ]);
    agentTools = new AgentTools(agentsDir, () => registry, eventBus, topics);
    const r = agentTools.listAgents('cos');
    expect(r.agents).toHaveLength(2);
  });

  it('marks self agent', () => {
    const registry = makeRegistry([
      fakeAgent({ getName: () => 'cos' }),
    ]);
    agentTools = new AgentTools(agentsDir, () => registry, eventBus, topics);
    const r = agentTools.listAgents('cos');
    expect(r.agents[0].self).toBe(true);
  });

  it('includes hires', () => {
    const cosDef = fakeAgentDefinition({ name: 'cos', manager: null });
    const therapistDef = fakeAgentDefinition({ name: 'therapist', manager: 'cos' });
    const cos = fakeAgent({ getName: () => 'cos', getDefinition: () => cosDef });
    const therapist = fakeAgent({ getName: () => 'therapist', getDefinition: () => therapistDef });
    const registry = makeRegistry([cos, therapist]);
    agentTools = new AgentTools(agentsDir, () => registry, eventBus, topics);
    const r = agentTools.listAgents('cos');
    const cosEntry = r.agents.find((a: any) => a.name === 'cos');
    expect(cosEntry.hires).toContain('therapist');
  });

  it('includes manager', () => {
    const therapistDef = fakeAgentDefinition({ name: 'therapist', manager: 'cos' });
    const therapist = fakeAgent({ getName: () => 'therapist', getDefinition: () => therapistDef });
    const registry = makeRegistry([therapist]);
    agentTools = new AgentTools(agentsDir, () => registry, eventBus, topics);
    const r = agentTools.listAgents('therapist');
    expect(r.agents[0].manager).toBe('cos');
  });
});

// ── readAgentDefinition ───────────────────────────────────────────────────────

describe('AgentTools.readAgentDefinition', () => {
  beforeEach(() => {
    agentTools = new AgentTools(agentsDir, () => makeRegistry([]), eventBus, topics);
  });

  it('returns agent definition files', () => {
    const agentDir = resolve(agentsDir, 'cos');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(resolve(agentDir, 'agent.yml'), yaml.dump({ name: 'cos', title: 'CoS' }));
    writeFileSync(resolve(agentDir, 'identity.md'), '# cos identity');
    const r = agentTools.readAgentDefinition('cos');
    expect(r.name).toBe('cos');
    expect(r['identity.md']).toBe('# cos identity');
  });

  it('returns error for non-existent agent', () => {
    const r = agentTools.readAgentDefinition('nonexistent');
    expect(r.error).toBeDefined();
  });
});

// ── createAgent ───────────────────────────────────────────────────────────────

describe('AgentTools.createAgent', () => {
  beforeEach(() => {
    agentTools = new AgentTools(agentsDir, () => makeRegistry([]), eventBus, topics);
  });

  it('creates agent files and returns success', () => {
    const r = agentTools.createAgent('pm_coach', 'PM Coach', 'Helps with PM', null, null, '# PM Coach', ['web_search']);
    expect(r.success).toBeDefined();
    const def = agentTools.readAgentDefinition('pm_coach');
    expect(def.name).toBe('pm_coach');
    expect(def['identity.md']).toBe('# PM Coach');
  });

  it('rejects invalid agent names', () => {
    expect(agentTools.createAgent('Invalid Name', null, null, null, null, 'id', []).error).toBeDefined();
    expect(agentTools.createAgent('123bad', null, null, null, null, 'id', []).error).toBeDefined();
    expect(agentTools.createAgent('', null, null, null, null, 'id', []).error).toBeDefined();
  });

  it('writes only agent-specific tools to yml (basic toolkit injected at runtime)', () => {
    agentTools.createAgent('my_agent', null, null, null, null, 'id', ['web_search']);
    const def = agentTools.readAgentDefinition('my_agent');
    expect(def.tools.names).toContain('web_search');
  });

  it('publishes agents_updated event on create', () => {
    const published: any[] = [];
    const origPublish = eventBus.publish.bind(eventBus);
    eventBus.publish = (e) => { published.push(e); origPublish(e); };
    agentTools.createAgent('test_agent', null, null, null, null, 'id', []);
    expect(published.some((e) => e.type === 'agents_updated')).toBe(true);
  });
});

// ── updateAgent ───────────────────────────────────────────────────────────────

describe('AgentTools.updateAgent', () => {
  beforeEach(() => {
    agentTools = new AgentTools(agentsDir, () => makeRegistry([]), eventBus, topics);
  });

  it('updates agent fields and preserves others', () => {
    agentTools.createAgent('advisor', 'Advisor', 'Old desc', 'Old goal', null, 'id', []);
    agentTools.updateAgent('advisor', 'New Title', null, null, null, null, null);
    const def = agentTools.readAgentDefinition('advisor');
    expect(def.title).toBe('New Title');
    expect(def.description).toBe('Old desc'); // preserved
  });

  it('returns error for non-existent agent', () => {
    const r = agentTools.updateAgent('nonexistent', 'T', null, null, null, null, null);
    expect(r.error).toBeDefined();
  });

  it('updates identity.md when provided', () => {
    agentTools.createAgent('coach', null, null, null, null, 'Original identity', []);
    agentTools.updateAgent('coach', null, null, null, null, null, 'New identity');
    const def = agentTools.readAgentDefinition('coach');
    expect(def['identity.md']).toBe('New identity');
  });
});

// ── messageAgent ──────────────────────────────────────────────────────────────

describe('AgentTools.messageAgent', () => {
  it('returns error when messaging self', async () => {
    agentTools = new AgentTools(agentsDir, () => makeRegistry([]), eventBus, topics);
    const r = await agentTools.messageAgent('cos', 'cos', 'hello');
    expect(r.error).toBeDefined();
  });

  it('returns error for unknown agent', async () => {
    agentTools = new AgentTools(agentsDir, () => makeRegistry([]), eventBus, topics);
    const r = await agentTools.messageAgent('cos', 'nonexistent', 'hi');
    expect(r.error).toBeDefined();
  });

  it('returns response from target agent', async () => {
    const therapist = fakeAgent({
      getName: () => 'therapist',
      handleAgentMessage: async () => 'I understand.',
    });
    const registry = makeRegistry([therapist]);
    agentTools = new AgentTools(agentsDir, () => registry, eventBus, topics);
    const r = await agentTools.messageAgent('cos', 'therapist', 'Hello');
    expect(r.response).toBe('I understand.');
    expect(r.agent).toBe('therapist');
  });
});

// ── messageAgentAsync ─────────────────────────────────────────────────────────

describe('AgentTools.messageAgentAsync', () => {
  it('returns queued status', () => {
    const therapist = fakeAgent({
      getName: () => 'therapist',
      handleAgentMessageAsync: () => {},
    });
    const registry = makeRegistry([therapist]);
    agentTools = new AgentTools(agentsDir, () => registry, eventBus, topics);
    const r = agentTools.messageAgentAsync('cos', 'therapist', 'hello async');
    expect(r.status).toBe('queued');
    expect(r.thread_id).toBeDefined();
  });

  it('returns error for self-message', () => {
    agentTools = new AgentTools(agentsDir, () => makeRegistry([]), eventBus, topics);
    const r = agentTools.messageAgentAsync('cos', 'cos', 'hi');
    expect(r.error).toBeDefined();
  });
});

// ── postMessage ───────────────────────────────────────────────────────────────

describe('AgentTools.postMessage', () => {
  it('broadcast returns broadcast status', () => {
    agentTools = new AgentTools(agentsDir, () => makeRegistry([]), eventBus, topics);
    const r = agentTools.postMessage('cos', 'hello everyone', []);
    expect(r.status).toBe('broadcast');
  });

  it('targeted returns queued status', () => {
    const therapist = fakeAgent({
      getName: () => 'therapist',
      handleAgentMessageAsync: () => {},
    });
    const registry = makeRegistry([therapist]);
    agentTools = new AgentTools(agentsDir, () => registry, eventBus, topics);
    const r = agentTools.postMessage('cos', 'targeted message', ['therapist']);
    expect(r.status).toBe('queued');
  });
});
