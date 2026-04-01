import { schedule } from 'node-cron';
import type { AgentFleet } from '../agent-fleet.js';

/**
 * Fires recurring platform-level events via cron.
 *
 * Intervals match the Java defaults:
 *   heartbeat_trigger        — every 6h
 *   self_eval_trigger        — every 12h
 *   self_learning_trigger    — every 24h
 *   session_expiry_check     — every 30 min
 */
export class AgentFleetScheduler {
  private stopped = false;

  constructor(private readonly fleet: AgentFleet) {}

  start(): void {
    // Every 30 min — check for expired sessions
    schedule('*/30 * * * *', () => {
      if (!this.stopped) this.fleet.checkExpiredSessions();
    });

    // Every 6h — heartbeat trigger for all agents
    schedule('0 */6 * * *', () => {
      if (!this.stopped) this.fleet.triggerHeartbeat();
    });

    // Every 12h — self-eval trigger for all agents
    schedule('0 */12 * * *', () => {
      if (!this.stopped) this.fleet.trigger('self_eval_trigger');
    });

    // Every 24h — self-learning trigger for all agents
    schedule('0 0 * * *', () => {
      if (!this.stopped) this.fleet.trigger('self_learning_trigger');
    });

    console.log('AgentFleetScheduler started');
  }

  stop(): void {
    this.stopped = true;
  }
}
