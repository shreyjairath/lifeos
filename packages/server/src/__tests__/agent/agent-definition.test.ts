import { describe, it, expect } from 'bun:test';
import { parseAgentDefinition } from '../../agent/agent-definition.js';

describe('parseAgentDefinition', () => {
  it('parses minimal definition with only name', () => {
    const def = parseAgentDefinition({ name: 'my_agent' }, '/base');
    expect(def.name).toBe('my_agent');
    expect(def.title).toBe('my_agent');
    expect(def.description).toBe('');
    expect(def.goal).toBeNull();
    expect(def.manager).toBeNull();
    expect(def.identity).toEqual([]);
    expect(def.tools).toBeNull();
    expect(def.disabledModes.size).toBe(0);
    expect(def.recurringTasks).toEqual([]);
    expect(def.subscribedTopics).toEqual([]);
    expect(def.model).toBeNull();
    expect(def.backgroundModel).toBeNull();
    expect(def.reasoning).toBeNull();
    expect(def.promptBase).toBe('/base');
  });

  it('parses full definition with all fields', () => {
    const def = parseAgentDefinition({
      name: 'cos',
      title: 'Chief of Staff',
      description: 'Manages things',
      goal: 'Be helpful',
      manager: 'client',
      identity: ['identity.md', 'extra.md'],
      tools: { mode: 'include', names: ['agent_bash', 'web_search'] },
      'disabled-modes': ['heartbeat_trigger'],
      'recurring-tasks': [
        { name: 'daily', prompt: 'daily.md', 'cadence-hours': 24 },
      ],
      'subscribed-topics': ['feed'],
      model: 'claude-opus-4',
      'background-model': 'claude-haiku',
      reasoning: { effort: 'high' },
    }, '/agents/cos');

    expect(def.name).toBe('cos');
    expect(def.title).toBe('Chief of Staff');
    expect(def.description).toBe('Manages things');
    expect(def.goal).toBe('Be helpful');
    expect(def.manager).toBe('client');
    expect(def.identity).toEqual(['identity.md', 'extra.md']);
    expect(def.tools).toEqual({ mode: 'include', names: ['agent_bash', 'web_search'] });
    expect(def.disabledModes.has('heartbeat_trigger')).toBe(true);
    expect(def.recurringTasks).toHaveLength(1);
    expect(def.recurringTasks[0]!.name).toBe('daily');
    expect(def.recurringTasks[0]!.cadenceHours).toBe(24);
    expect(def.subscribedTopics).toEqual(['feed']);
    expect(def.model).toBe('claude-opus-4');
    expect(def.backgroundModel).toBe('claude-haiku');
    expect(def.reasoning).toEqual({ effort: 'high' });
  });

  it('tools is null when not specified', () => {
    const def = parseAgentDefinition({ name: 'agent' }, '/base');
    expect(def.tools).toBeNull();
  });

  it('disabledModes is a Set with correct membership', () => {
    const def = parseAgentDefinition({
      name: 'agent',
      'disabled-modes': ['heartbeat_trigger', 'self_eval_trigger'],
    }, '/base');
    expect(def.disabledModes).toBeInstanceOf(Set);
    expect(def.disabledModes.has('heartbeat_trigger')).toBe(true);
    expect(def.disabledModes.has('chat')).toBe(false);
  });

  it('recurringTasks numeric coercion from string', () => {
    const def = parseAgentDefinition({
      name: 'agent',
      'recurring-tasks': [{ name: 'task', prompt: 'p.md', 'cadence-hours': '12' }],
    }, '/base');
    expect(def.recurringTasks[0]!.cadenceHours).toBe(12);
    expect(typeof def.recurringTasks[0]!.cadenceHours).toBe('number');
  });

  it('recurringTasks disabled defaults to false', () => {
    const def = parseAgentDefinition({
      name: 'agent',
      'recurring-tasks': [{ name: 'task', prompt: 'p.md', 'cadence-hours': 6 }],
    }, '/base');
    expect(def.recurringTasks[0]!.disabled).toBe(false);
  });

  it('recurringTasks disabled can be set to true', () => {
    const def = parseAgentDefinition({
      name: 'agent',
      'recurring-tasks': [{ name: 'task', prompt: 'p.md', 'cadence-hours': 6, disabled: true }],
    }, '/base');
    expect(def.recurringTasks[0]!.disabled).toBe(true);
  });

  it('reasoning with effort only', () => {
    const def = parseAgentDefinition({ name: 'a', reasoning: { effort: 'medium' } }, '/base');
    expect(def.reasoning).toEqual({ effort: 'medium', maxTokens: undefined });
  });

  it('reasoning with max-tokens only', () => {
    const def = parseAgentDefinition({ name: 'a', reasoning: { 'max-tokens': 2000 } }, '/base');
    expect(def.reasoning?.maxTokens).toBe(2000);
    expect(def.reasoning?.effort).toBeUndefined();
  });
});
