import { schedule } from 'node-cron';
import type { AgentFleet } from '../agent-fleet.js';

export class AgentFleetScheduler {
  private stopped = false;

  constructor(private readonly fleets: AgentFleet[]) {}

  start(): void {
    // Every 30 min — check for expired sessions
    schedule('*/30 * * * *', () => {
      if (!this.stopped) this.fleets.forEach((f) => f.checkExpiredSessions());
    });

    // Every 5min — system email triage (routes to opted-in agents)
    schedule('*/5 * * * *', () => {
      if (!this.stopped) this.fleets.forEach((f) => void f.triggerEmailCheck());
    });

    // Every 5 min — dispatch overdue tasks to assignee agents
    schedule('*/5 * * * *', () => {
      if (!this.stopped) this.fleets.forEach((f) => void f.triggerTaskCheck());
    });

    console.log('AgentFleetScheduler started');
  }

  stop(): void {
    this.stopped = true;
  }
}
