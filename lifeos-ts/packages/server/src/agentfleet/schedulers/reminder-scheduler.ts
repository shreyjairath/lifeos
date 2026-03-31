import { schedule } from 'node-cron';
import type { ReminderStore } from '../tools/reminders.js';
import type { PushNotifier } from '../../agent/types.js';

/**
 * Polls for due reminders every minute and sends push notifications.
 */
export class ReminderScheduler {
  private stopped = false;

  constructor(
    private readonly reminders: ReminderStore,
    private readonly push: PushNotifier,
  ) {}

  start(): void {
    schedule('* * * * *', async () => {
      if (this.stopped) return;
      const due = this.reminders.pollDue();
      for (const r of due) {
        try {
          await this.push.sendToAll(r.title ?? 'Reminder', r.body ?? '');
        } catch (err: any) {
          console.warn('Reminder push failed:', err?.message);
        }
      }
    });
    console.log('ReminderScheduler started');
  }

  stop(): void {
    this.stopped = true;
  }
}
