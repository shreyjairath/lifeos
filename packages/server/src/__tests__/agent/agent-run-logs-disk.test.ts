import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { saveRunRecord, getRecentRuns, createRunRecord } from '../../agent/agent-run-logs.js';
import { makeTempDir, cleanupDir } from '../helpers.js';

let agentsDir: string;

beforeEach(() => {
  agentsDir = makeTempDir('run-logs-disk');
});

afterEach(() => {
  cleanupDir(agentsDir);
});

describe('saveRunRecord', () => {
  it('writes a JSON file under {agentsDir}/{agent}/runs/', () => {
    const record = createRunRecord('cos', 'chat', 'sys', 'hello', 'claude-3', 'sess-1');
    saveRunRecord(record, agentsDir);
    const runs = getRecentRuns('cos', agentsDir);
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(record.id);
    expect(runs[0].agent).toBe('cos');
  });
});

describe('getRecentRuns', () => {
  it('returns empty array for missing agent', () => {
    expect(getRecentRuns('no_such_agent', agentsDir)).toEqual([]);
  });

  it('returns runs sorted newest-first', async () => {
    const r1 = createRunRecord('cos', 'chat', 's', 'm', 'model');
    saveRunRecord(r1, agentsDir);
    await Bun.sleep(5);
    const r2 = createRunRecord('cos', 'chat', 's', 'm', 'model');
    saveRunRecord(r2, agentsDir);

    const runs = getRecentRuns('cos', agentsDir);
    expect(runs).toHaveLength(2);
    expect(runs[0].id).toBe(r2.id); // newest first
  });

  it('respects the limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await Bun.sleep(2);
      saveRunRecord(createRunRecord('cos', 'chat', 's', 'm', 'model'), agentsDir);
    }
    const runs = getRecentRuns('cos', agentsDir, 3);
    expect(runs).toHaveLength(3);
  });
});
