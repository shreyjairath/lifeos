import { describe, it, expect } from 'bun:test';
import { EventBus } from '../../agentfleet/event-bus.js';

describe('EventBus.publish + getHistory', () => {
  it('publish adds event to history', () => {
    const bus = new EventBus();
    bus.publish({ type: 'test', value: 1 });
    expect(bus.getHistory()).toHaveLength(1);
    expect(bus.getHistory()[0]).toEqual({ type: 'test', value: 1 });
  });

  it('history caps at 500 events', () => {
    const bus = new EventBus();
    for (let i = 0; i < 501; i++) bus.publish({ i });
    expect(bus.getHistory()).toHaveLength(500);
    expect(bus.getHistory()[0]).toEqual({ i: 1 });
  });

  it('getHistory returns a copy — mutating does not affect bus', () => {
    const bus = new EventBus();
    bus.publish({ type: 'a' });
    const h = bus.getHistory();
    h.push({ type: 'injected' });
    expect(bus.getHistory()).toHaveLength(1);
  });
});

describe('EventBus.subscribe', () => {
  it('delivers published event to subscriber', async () => {
    const bus = new EventBus();
    const iter = bus.subscribe();
    bus.publish({ type: 'hello' });
    const result = await iter.next();
    expect(result.done).toBe(false);
    expect(result.value).toEqual({ type: 'hello' });
    await iter.return!();
  });

  it('delivers events queued before next() is called', async () => {
    const bus = new EventBus();
    const iter = bus.subscribe();
    bus.publish({ type: 'early' });
    const result = await iter.next();
    expect(result.value).toEqual({ type: 'early' });
    await iter.return!();
  });

  it('multiple subscribers each receive the event', async () => {
    const bus = new EventBus();
    const a = bus.subscribe();
    const b = bus.subscribe();
    bus.publish({ type: 'shared' });
    const ra = await a.next();
    const rb = await b.next();
    expect(ra.value).toEqual({ type: 'shared' });
    expect(rb.value).toEqual({ type: 'shared' });
    await a.return!();
    await b.return!();
  });

  it('return() stops the iterator', async () => {
    const bus = new EventBus();
    const iter = bus.subscribe();
    await iter.return!();
    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  it('throw() stops the iterator', async () => {
    const bus = new EventBus();
    const iter = bus.subscribe();
    await iter.throw!(new Error('boom'));
    const result = await iter.next();
    expect(result.done).toBe(true);
  });
});
