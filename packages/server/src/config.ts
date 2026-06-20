import { readFileSync } from 'fs';
import { resolve } from 'path';
import yaml from 'js-yaml';
import { MONOREPO_ROOT } from './root.js';

export interface ReasoningConfig {
  effort?: string;
  maxTokens?: number;
}

export interface SessionConfig {
  tokenThreshold: number;
  timeThresholdHours: number;
}

export interface Contact {
  email: string;
  agents: string[];
  fallback: string;
}

export interface ClientConfig {
  id: string;
  name: string;
  email: string;
  mailboxAddress: string;
  timezone: string;
  contacts: Contact[];
  disabled?: boolean;
}

export interface AppConfig {
  port: number;
  apiKey: string;
  braveSearchApiKey: string;
  model: string;
  backgroundModel: string;
  clients: ClientConfig[];
  reasoning: ReasoningConfig | null;
  session: SessionConfig;
  heartbeatCron: string;
  sessionExpiryCheckCron: string;
}

function parseContacts(raw: Record<string, any>[]): Contact[] {
  return raw.map((c) => ({
    email: (c.email as string).toLowerCase(),
    agents: (c.agents ?? []) as string[],
    fallback: c.fallback as string,
  }));
}

function parseClients(lifeos: Record<string, any>): ClientConfig[] {
  // New multi-client format: clients: [{ id, name, email, mailbox-address, contacts }]
  if (Array.isArray(lifeos.clients)) {
    return (lifeos.clients as Record<string, any>[]).map((c) => ({
      id: c.id as string,
      name: c.name as string,
      email: (c.email as string) ?? '',
      mailboxAddress: (c['mailbox-address'] as string) ?? '',
      timezone: (c.timezone as string) ?? 'America/New_York',
      contacts: parseContacts((c.contacts ?? []) as Record<string, any>[]),
      disabled: (c.disabled as boolean) ?? false,
    }));
  }
  // Legacy single-client format: client-name, client-email, mailbox-email, contacts
  return [{
    id: 'default',
    name: lifeos['client-name'] ?? '',
    email: lifeos['client-email'] ?? '',
    mailboxAddress: lifeos['mailbox-email'] ?? '',
    timezone: (lifeos.timezone as string) ?? 'America/New_York',
    contacts: parseContacts((lifeos.contacts ?? []) as Record<string, any>[]),
  }];
}

function envReplace(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '');
}

export function loadConfig(configPath?: string): AppConfig {
  const path = configPath ?? process.env.LIFEOS_CONFIG ?? resolve(MONOREPO_ROOT, 'config.yml');
  let raw: Record<string, any> = {};
  try {
    raw = yaml.load(readFileSync(path, 'utf-8')) as Record<string, any>;
  } catch {
    // fall through to defaults
  }

  const lifeos = raw?.lifeos ?? {};
  const session = lifeos.session ?? {};
  const reasoning = lifeos.reasoning ?? null;
  const heartbeat = lifeos.heartbeat ?? {};
  const expiryCheck = lifeos['session-expiry-check'] ?? {};

  if (!lifeos.model) throw new Error('[config] lifeos.model is required in config.yml');
  if (!lifeos['background-model']) throw new Error('[config] lifeos.background-model is required in config.yml');

  return {
    port: process.env.PORT ? parseInt(process.env.PORT) : (raw?.server?.port ?? 8000),
    apiKey: process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || '',
    braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY || '',
    model: lifeos.model,
    backgroundModel: lifeos['background-model'],
    clients: parseClients(lifeos),
    reasoning: reasoning
      ? {
          effort: reasoning.effort ?? undefined,
          maxTokens: reasoning['max-tokens'] ?? undefined,
        }
      : null,
    session: {
      tokenThreshold: session['token-threshold'] ?? 100_000,
      timeThresholdHours: session['time-threshold-hours'] ?? 4,
    },
    heartbeatCron: heartbeat.cron ?? '0 0 */4 * * *',
    sessionExpiryCheckCron: expiryCheck.cron ?? '0 0 * * * *',
  };
}
