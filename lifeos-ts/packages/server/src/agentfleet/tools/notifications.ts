import type { AgentRegistry } from '../agent-registry.js';
import type { EventBus } from '../event-bus.js';
import type { PushNotifier } from '../../agent/types.js';

export class Notifications {
  constructor(
    private readonly getRegistry: () => AgentRegistry,
    private readonly eventBus: EventBus,
    private readonly webPush: PushNotifier,
  ) {}

  notifyUser(
    agentName: string,
    message: string,
    urgency?: string,
    context?: string,
  ): Record<string, any> {
    if (!message?.trim()) return { error: 'message is required' };

    const registry = this.getRegistry();
    const agent = registry.get(agentName);
    const agentTitle = agent?.getTitle() ?? agentName;
    const urg = urgency ?? 'medium';

    // Web push — fires even when browser is closed
    void this.webPush.sendToAll(agentTitle, message);

    // SSE event — renders as toast when browser is open
    const event: Record<string, any> = {
      type: 'notification',
      agent: agentName,
      agentTitle,
      message,
      urgency: urg,
    };
    if (context?.trim()) event.context = context;
    this.eventBus.publish(event);

    return { status: 'sent', title: agentTitle, message };
  }
}
