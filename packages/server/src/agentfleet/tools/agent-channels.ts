import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import type { ChannelLog } from '../../agent/types.js';
import { MONOREPO_ROOT } from '../../root.js';

const CHANNELS_DIR = resolve(MONOREPO_ROOT, '.user-data', 'inter-agent-channels');
const MAX_ENTRIES = 100;

export class AgentChannels implements ChannelLog {
  loadFull(agentA: string, agentB: string): string {
    const file = channelFile(agentA, agentB);
    if (!existsSync(file)) return '';
    try {
      return readFileSync(file, 'utf-8');
    } catch {
      return '';
    }
  }

  append(fromAgent: string, toAgent: string, inbound: string, response: string): void {
    const file = channelFile(fromAgent, toAgent);
    const now = new Intl.DateTimeFormat('en-US', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    }).format(new Date());
    const entry = `## ${now} | ${fromAgent} → ${toAgent}\n${inbound}\n\n**${toAgent} replied:**\n${response}\n\n---\n\n`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, entry, 'utf-8');
      prune(file);
    } catch (err) {
      console.warn(`[AgentChannels] Failed to append channel log ${file}:`, err);
    }
  }

  readChannel(callerAgent: string, partnerAgent: string): Record<string, any> {
    const raw = this.loadFull(callerAgent, partnerAgent);
    if (!raw.trim()) return { log: 'No prior exchanges.' };
    const entries = raw.split(/(?<=\n---\n\n)/);
    const last10 = entries.length <= 10 ? raw : entries.slice(-10).join('');
    return { log: last10 };
  }
}

function channelFile(agentA: string, agentB: string): string {
  const pair = agentA < agentB ? `${agentA}-${agentB}` : `${agentB}-${agentA}`;
  return resolve(CHANNELS_DIR, `${pair}.md`);
}

function prune(file: string): void {
  try {
    const raw = readFileSync(file, 'utf-8');
    const entries = raw.split(/(?<=\n---\n\n)/);
    if (entries.length > MAX_ENTRIES) {
      const trimmed = entries.slice(-MAX_ENTRIES).join('');
      writeFileSync(file, trimmed, 'utf-8');
    }
  } catch { /* ignore prune failures */ }
}
