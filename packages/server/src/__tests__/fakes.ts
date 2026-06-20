import type { AppConfig, ClientConfig } from '../config.js';
import type { AgentDefinition } from '../agent/agent-definition.js';
import type { ToolInvoker, ToolDefinition, Agent, ExecutorEvent } from '../agent/types.js';
import type { SessionHandler } from '../agent/session/session-handler.js';
import type { EmailThreadStore } from '../agentfleet/tools/email-thread-store.js';

export function fakeAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 8000,
    apiKey: 'test-api-key',
    braveSearchApiKey: 'test-brave-key',
    model: 'test-model',
    backgroundModel: 'test-bg-model',
    clients: [],
    reasoning: null,
    session: { tokenThreshold: 50_000, timeThresholdHours: 4 },
    heartbeatCron: '0 0 */6 * * *',
    sessionExpiryCheckCron: '0 */30 * * * *',
    ...overrides,
  };
}

export function fakeClientConfig(overrides: Partial<ClientConfig> = {}): ClientConfig {
  return {
    id: 'test-client',
    name: 'Test User',
    email: 'test@example.com',
    mailboxAddress: '',
    timezone: 'America/New_York',
    contacts: [],
    ...overrides,
  };
}

export function fakeAgentDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'test_agent',
    title: 'Test Agent',
    description: 'A test agent',
    goal: null,
    promptBase: '',
    manager: null,
    identity: [],
    tools: null,
    disabledModes: new Set(),
    recurringTasks: [],
    subscribedTopics: [],
    model: null,
    backgroundModel: null,
    reasoning: null,
    ...overrides,
  };
}

export function fakeToolInvoker(
  handler?: (name: string, input: Record<string, any>, agent: string) => Record<string, any>,
): ToolInvoker {
  return {
    definitions(): ToolDefinition[] { return []; },
    invoke(name, input, agent) {
      return handler ? handler(name, input, agent) : { ok: true };
    },
  };
}

export function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    emailThreadStore: {
      getLastSeen: () => null,
      markSeen: () => {},
      readSummary: () => null,
      writeSummary: () => {},
      remove: () => {},
    } as EmailThreadStore,
    getName: () => 'fake_agent',
    getTitle: () => 'Fake Agent',
    getDescription: () => 'A fake agent',
    getDefinition: () => fakeAgentDefinition(),
    getSessionHandler: () => { throw new Error('getSessionHandler not implemented in fake'); },
    cancel: () => {},
    handleUserMessage: async function*() {},
    handleAgentMessage: async () => 'fake response',
    handleAgentMessageAsync: () => {},
    getWorkspaceDir: () => '/tmp/fake-workspace',
    handleEmailCheck: () => {},
    handleOverdueTask: () => {},
    ...overrides,
  } as Agent;
}
