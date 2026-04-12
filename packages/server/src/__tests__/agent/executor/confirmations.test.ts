import { describe, it, expect } from 'bun:test';
import { Confirmations } from '../../../agent/executor/confirmations.js';

describe('Confirmations.isGated', () => {
  const c = new Confirmations();

  it('returns true for known gated tools', () => {
    expect(c.isGated('run_python')).toBe(true);
    expect(c.isGated('claude_code')).toBe(true);
    expect(c.isGated('chrome_open')).toBe(true);
    expect(c.isGated('chrome_click')).toBe(true);
    expect(c.isGated('chrome_type')).toBe(true);
    expect(c.isGated('chrome_screenshot')).toBe(true);
  });

  it('returns false for non-gated tools', () => {
    expect(c.isGated('agent_bash')).toBe(false);
    expect(c.isGated('web_search')).toBe(false);
    expect(c.isGated('send_email')).toBe(false);
    expect(c.isGated('unknown_tool')).toBe(false);
  });
});

describe('Confirmations.register + resolve', () => {
  it('register returns a requestId and promise', () => {
    const c = new Confirmations();
    const { requestId, promise } = c.register();
    expect(typeof requestId).toBe('string');
    expect(requestId.length).toBeGreaterThan(0);
    expect(promise).toBeInstanceOf(Promise);
    // Clean up to avoid dangling timer
    c.resolve(requestId, false);
  });

  it('resolve(true) fulfills promise with true', async () => {
    const c = new Confirmations();
    const { requestId, promise } = c.register();
    c.resolve(requestId, true);
    expect(await promise).toBe(true);
  });

  it('resolve(false) fulfills promise with false', async () => {
    const c = new Confirmations();
    const { requestId, promise } = c.register();
    c.resolve(requestId, false);
    expect(await promise).toBe(false);
  });

  it('resolve unknown requestId returns false', () => {
    const c = new Confirmations();
    expect(c.resolve('nonexistent', true)).toBe(false);
  });

  it('resolve returns true on first call, false on second', async () => {
    const c = new Confirmations();
    const { requestId, promise } = c.register();
    expect(c.resolve(requestId, true)).toBe(true);
    expect(c.resolve(requestId, false)).toBe(false);
    await promise;
  });
});
