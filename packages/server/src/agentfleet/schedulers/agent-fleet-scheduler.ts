import { schedule } from 'node-cron';
import type { AgentFleet } from '../agent-fleet.js';

export class AgentFleetScheduler {
  private stopped = false;

  constructor(private readonly fleet: AgentFleet) {}

  start(): void {
    // Every 30 min — check for expired sessions
    schedule('*/30 * * * *', () => {
      if (!this.stopped) this.fleet.checkExpiredSessions();
    });

    // Every 5min — system email triage (routes to opted-in agents)
    schedule('*/5 * * * *', () => {
      if (!this.stopped) void this.fleet.triggerEmailCheck();
    });

    // Every 30 min — dispatch overdue tasks to assignee agents
    schedule('*/30 * * * *', () => {
      if (!this.stopped) void this.fleet.triggerTaskCheck();
    });

    console.log('AgentFleetScheduler started');
  }

  stop(): void {
    this.stopped = true;
  }
}
