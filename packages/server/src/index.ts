import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { loadConfig } from './config.js';

// Agent layer
import { Confirmations } from './agent/executor/confirmations.js';

// Platform layer
import { EventBus } from './agentfleet/event-bus.js';
import { ToolsRegistry } from './agentfleet/tools-registry.js';
import { AgentRegistry } from './agentfleet/agent-registry.js';
import { AgentRouter } from './agentfleet/agent-router.js';
import { AgentFleet } from './agentfleet/agent-fleet.js';
import { WebPushService } from './agentfleet/web-push-service.js';
import { AgentFleetScheduler } from './agentfleet/schedulers/agent-fleet-scheduler.js';

// Tool implementations
import { AgentTools } from './agentfleet/tools/agent-tools.js';
import { WebSearch } from './agentfleet/tools/web-search.js';
import { Browse } from './agentfleet/tools/browse.js';
import { Notifications } from './agentfleet/tools/notifications.js';

// Routes
import { chatRoutes } from './routes/chat.js';
import { sessionRoutes } from './routes/sessions.js';
import { agentRoutes } from './routes/agents.js';
import { eventRoutes } from './routes/events.js';
import { pushRoutes } from './routes/push.js';
import { toolsRoutes } from './routes/tools.js';
import { artifactsRoutes } from './routes/artifacts.js';
import { ccRoutes } from './routes/cc.js';

// Gmail
import { GmailClient, GMAIL_CREDENTIALS_PATH } from './agentfleet/tools/gmail.js';

async function createApp() {
  const config = loadConfig();
  console.log(`[config] apiKey: ${config.apiKey ? config.apiKey.slice(0, 8) + '...' : '(empty)'}`);

  // ── Core dependencies ──────────────────────────────────────────────────────

  const confirmations = new Confirmations();
  const eventBus = new EventBus();
  const webPush = new WebPushService();
  webPush.init();

  // ── Tool implementations ───────────────────────────────────────────────────

  const toolsRegistry = new ToolsRegistry();
  toolsRegistry.init();

  const webSearch = new WebSearch();
  const browse = new Browse();

  // ── Agent registry (must be before AgentTools — lazy ref) ─────────────────

  const registry = new AgentRegistry(toolsRegistry, eventBus, confirmations, config);

  // Tools that need lazy registry reference (circular dep)
  const agentTools = new AgentTools(() => registry, eventBus, toolsRegistry.topics);
  const notifications = new Notifications(() => registry, eventBus, webPush);

  // Wire injectable deps into ToolsRegistry
  toolsRegistry.agentTools = agentTools;
  toolsRegistry.webSearch = webSearch;
  toolsRegistry.browse = browse;
  toolsRegistry.notifications = notifications;
  toolsRegistry.eventBusPublish = (e) => eventBus.publish(e);
  toolsRegistry.clientEmail = config.clientEmail;

  registry.load();

  // ── Platform layer ─────────────────────────────────────────────────────────

  const router = new AgentRouter(registry, eventBus);
  const fleet = new AgentFleet(registry, eventBus, router, config, toolsRegistry);

  // Upsert recurring tasks defined in agent.yml
  fleet.initBackgroundTasks();

  // Start background listeners on all agents
  for (const agent of registry.all()) {
    (agent as any).initListeners?.();
  }

  // ── Schedulers ─────────────────────────────────────────────────────────────

  const fleetScheduler = new AgentFleetScheduler(fleet);
  fleetScheduler.start();

  // ── Hono app ───────────────────────────────────────────────────────────────

  const app = new Hono();
  app.use('*', cors());

  // Health
  app.get('/api/health', (c) => c.json({ status: 'ok' }));

  // API routes
  app.route('/api', chatRoutes(fleet, confirmations));
  app.route('/api', sessionRoutes(fleet));
  app.route('/api', agentRoutes(fleet));
  app.route('/api', eventRoutes(eventBus));
  app.route('/api', pushRoutes(webPush));
  app.route('/api', toolsRoutes(fleet));
  app.route('/api', artifactsRoutes());
  app.route('/api', ccRoutes(config));

  // Wire Gmail tools if credentials exist
  const gmail = new GmailClient(GMAIL_CREDENTIALS_PATH);
  if (gmail.isConfigured()) {
    toolsRegistry.setGmailClient(gmail);
    console.log('[gmail] tools enabled');
  }

  console.log(`lifeos-ts server starting on port ${config.port}`);
  return { port: config.port, fetch: app.fetch, idleTimeout: 0 };
}

export default await createApp();
