import { readFileSync } from 'fs';
import { resolve } from 'path';
import yaml from 'js-yaml';
import { MONOREPO_ROOT } from './root.js';

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ReasoningConfig {
  effort?: string;
  maxTokens?: number;
}

export interface SessionConfig {
  tokenThreshold: number;
  timeThresholdHours: number;
}

export interface AppConfig {
  port: number;
  apiKey: string;
  model: string;
  backgroundModel: string;
  reasoning: ReasoningConfig | null;
  session: SessionConfig;
  heartbeatCron: string;
  sessionExpiryCheckCron: string;
  mcpServers: McpServerConfig[];
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

  return {
    port: process.env.PORT ? parseInt(process.env.PORT) : (raw?.server?.port ?? 8000),
    apiKey: envReplace(lifeos['api-key'] ?? '') || process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || '',
    model: lifeos.model ?? 'anthropic/claude-haiku-4-5-20251001',
    backgroundModel: lifeos['background-model'] ?? 'anthropic/claude-haiku-4-5-20251001',
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
    mcpServers: (lifeos['mcp-servers'] ?? []).map((s: any) => ({
      name: s.name,
      command: s.command,
      args: s.args ?? [],
      env: s.env ?? {},
    })),
  };
}
