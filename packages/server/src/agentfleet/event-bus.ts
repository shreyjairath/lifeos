const MAX_HISTORY = 500;

type BusEvent = Record<string, any>;
type BusListener = (event: BusEvent) => void;

/**
 * In-memory pub/sub event bus.
 * publish() pushes to all active subscribers and the rolling history buffer.
 * subscribe() returns an AsyncIterableIterator that yields events as they arrive.
 */
export class EventBus {
  private readonly listeners = new Set<BusListener>();
  private readonly history: BusEvent[] = [];

  publish(event: BusEvent): void {
    if (this.history.length >= MAX_HISTORY) this.history.shift();
    this.history.push(event);
    for (const fn of this.listeners) {
      try { fn(event); } catch { /* never let a subscriber crash the bus */ }
    }
  }

  /**
   * Returns an AsyncIterableIterator that yields events as they arrive.
   * Cleanup (unsubscribe) happens automatically when the iterator is returned/thrown.
   */
  subscribe(): AsyncIterableIterator<BusEvent> {
    const queue: BusEvent[] = [];
    let pending: ((value: IteratorResult<BusEvent>) => void) | null = null;
    let done = false;

    const listener: BusListener = (event) => {
      if (done) return;
      if (pending) {
        const resolve = pending;
        pending = null;
        resolve({ value: event, done: false });
      } else {
        queue.push(event);
      }
    };

    this.listeners.add(listener);

    const cleanup = () => {
      done = true;
      this.listeners.delete(listener);
      if (pending) {
        const resolve = pending;
        pending = null;
        resolve({ value: undefined as any, done: true });
      }
    };

    const iterator: AsyncIterableIterator<BusEvent> = {
      next(): Promise<IteratorResult<BusEvent>> {
        if (queue.length > 0) {
          return Promise.resolve({ value: queue.shift()!, done: false });
        }
        if (done) {
          return Promise.resolve({ value: undefined as any, done: true });
        }
        return new Promise((resolve) => { pending = resolve; });
      },
      return(): Promise<IteratorResult<BusEvent>> {
        cleanup();
        return Promise.resolve({ value: undefined as any, done: true });
      },
      throw(): Promise<IteratorResult<BusEvent>> {
        cleanup();
        return Promise.resolve({ value: undefined as any, done: true });
      },
      [Symbol.asyncIterator]() { return this; },
    };

    return iterator;
  }

  getHistory(): BusEvent[] {
    return [...this.history];
  }
}
