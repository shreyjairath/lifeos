import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import yaml from 'js-yaml';
import { AgentRegistry } from '../../agentfleet/agent-registry.js';
import { EventBus } from '../../agentfleet/event-bus.js';
import { Confirmations } from '../../agent/executor/confirmations.js';
import { makeTempDir, cleanupDir } from '../helpers.js';
import { fakeAppConfig, fakeClientConfig, fakeToolInvoker } from '../fakes.js';
import type { ToolsRegistry } from '../../agentfleet/tools-registry.js';

let tmpDir: string;
let builtinDir: string;
let dynamicDir: string;
let registry: AgentRegistry;

function makeToolsRegistry(): ToolsRegistry {
  return {
    getTools: () => [],
    makeInvoker: () => fakeToolInvoker(),
    registerAgentWorkspace: () => {},
    topics: { writeTopic: () => ({}), readTopic: () => ({ messages: [], count: 0 }), listTopics: () => ({ topics: [] }), getTopicsDir: () => '' } as any,
    getScheduledTasks: () => ({}) as any,
    getAgentsDir: () => dynamicDir,
    allToolNames: () => [],
    loadDisabledTools: () => new Set(),
    saveDisabledTools: () => {},
    dispatch: async () => ({}),
    init: () => {},
    agentTools: undefined as any,
    webSearch: undefined as any,
    browse: undefined as any,
    eventBusPublish: () => {},
    clientEmail: '',
    setGmailClient: () => {},
    getGmailClient: () => null,
  } as unknown as ToolsRegistry;
}

function writeAgentYml(dir: string, name: string, extra: Record<string, any> = {}): void {
  const agentDir = resolve(dir, name);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(resolve(agentDir, 'agent.yml'), yaml.dump({ name, title: name, ...extra }));
  writeFileSync(resolve(agentDir, 'identity.md'), `# ${name} identity`);
}

beforeEach(() => {
  tmpDir = makeTempDir('agent-registry');
  builtinDir = resolve(tmpDir, 'builtin');
  dynamicDir = resolve(tmpDir, 'agents'); // AgentRegistry resolves {clientDataDir}/agents
  mkdirSync(builtinDir, { recursive: true });
  mkdirSync(dynamicDir, { recursive: true });

  registry = new AgentRegistry(
    makeToolsRegistry(),
    new EventBus(),
    new Confirmations(),
    fakeAppConfig(),
    fakeClientConfig(),
    tmpDir,
    builtinDir,
  );
});

afterEach(() => {
  cleanupDir(tmpDir);
});

describe('AgentRegistry.load', () => {
  it('loads agents from builtin dir', () => {
    writeAgentYml(builtinDir, 'cos');
    registry.load();
    expect(registry.all()).toHaveLength(1);
    expect(registry.all()[0].getName()).toBe('cos');
  });

  it('loads agents from dynamic dir', () => {
    writeAgentYml(dynamicDir, 'therapist');
    registry.load();
    expect(registry.all()).toHaveLength(1);
  });

  it('loads from both dirs', () => {
    writeAgentYml(builtinDir, 'cos');
    writeAgentYml(dynamicDir, 'therapist');
    registry.load();
    expect(registry.all()).toHaveLength(2);
  });

  it('skips dirs without agent.yml', () => {
    mkdirSync(resolve(builtinDir, 'empty_agent'), { recursive: true });
    registry.load();
    expect(registry.all()).toHaveLength(0);
  });

  it('handles non-existent dirs gracefully', () => {
    // builtinDir and dynamicDir exist but are empty
    expect(() => registry.load()).not.toThrow();
  });
});

describe('AgentRegistry.register', () => {
  it('hot-registers an agent from YAML', () => {
    const agentDir = resolve(dynamicDir, 'new_agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(resolve(agentDir, 'identity.md'), '# new agent');
    const yaml_content = yaml.dump({ name: 'new_agent', title: 'New Agent' });
    const agent = registry.register(yaml_content, agentDir);
    expect(agent.getName()).toBe('new_agent');
    expect(registry.all()).toHaveLength(1);
  });

  it('re-registers (overwrites) an existing agent', () => {
    const agentDir = resolve(dynamicDir, 'cos');
    mkdirSync(agentDir, { recursive: true });
    const yaml1 = yaml.dump({ name: 'cos', title: 'Old Title' });
    const yaml2 = yaml.dump({ name: 'cos', title: 'New Title' });
    registry.register(yaml1, agentDir);
    registry.register(yaml2, agentDir);
    expect(registry.all()).toHaveLength(1);
    expect(registry.get('cos').getTitle()).toBe('New Title');
  });
});

describe('AgentRegistry.get', () => {
  it('returns agent by name', () => {
    writeAgentYml(builtinDir, 'cos');
    registry.load();
    const a = registry.get('cos');
    expect(a.getName()).toBe('cos');
  });

  it('falls back to first agent for unknown name', () => {
    writeAgentYml(builtinDir, 'cos');
    registry.load();
    const a = registry.get('nonexistent');
    expect(a.getName()).toBe('cos');
  });

  it('throws when no agents loaded', () => {
    expect(() => registry.get('anything')).toThrow('No agents loaded');
  });
});

describe('AgentRegistry.all', () => {
  it('returns empty array before load', () => {
    expect(registry.all()).toEqual([]);
  });

  it('returns all loaded agents', () => {
    writeAgentYml(builtinDir, 'cos');
    writeAgentYml(builtinDir, 'advisor');
    registry.load();
    expect(registry.all()).toHaveLength(2);
  });
});
