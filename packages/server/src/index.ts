import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { loadConfig } from './config.js';

// Agent layer
import { Confirmations } from './agent/executor/confirmations.js';
import { LlmClient } from './agent/executor/llm-client.js';

// Platform layer
import { EventBus } from './agentfleet/event-bus.js';
import { ToolsRegistry } from './agentfleet/tools-registry.js';
import { AgentRegistry } from './agentfleet/agent-registry.js';
import { AgentRouter } from './agentfleet/agent-router.js';
import { AgentFleet } from './agentfleet/agent-fleet.js';
import { AgentFleetScheduler } from './agentfleet/schedulers/agent-fleet-scheduler.js';

// Tool implementations
import { AgentTools } from './agentfleet/tools/agent-tools.js';
import { WebSearch } from './agentfleet/tools/web-search.js';
import { Browse } from './agentfleet/tools/browse.js';
import { Verifier } from './agentfleet/tools/verifier.js';

// Routes
import { chatRoutes } from './routes/chat.js';
import { sessionRoutes } from './routes/sessions.js';
import { agentRoutes } from './routes/agents.js';
import { eventRoutes } from './routes/events.js';
import { toolsRoutes } from './routes/tools.js';
import { artifactsRoutes } from './routes/artifacts.js';
import { ccRoutes } from './routes/cc.js';
import { journalRoutes } from './routes/journal.js';

// Gmail
import { GmailClient } from './agentfleet/tools/gmail.js';
import { clientDataDir } from './root.js';

async function createApp() {
  const config = loadConfig();
  console.log(`[config] apiKey: ${config.apiKey ? config.apiKey.slice(0, 8) + '...' : '(empty)'}`);
  const enabledClients = config.clients.filter((c) => !c.disabled);
  const disabledClients = config.clients.filter((c) => c.disabled);
  console.log(`[config] clients: ${enabledClients.map((c) => c.id).join(', ')}`);
  if (disabledClients.length) console.log(`[config] disabled clients: ${disabledClients.map((c) => c.id).join(', ')}`);

  // ── Shared stateless tools ────────────────────────────────────────────────

  const verifier = new Verifier(new LlmClient(config.apiKey), config.backgroundModel);
  const webSearch = new WebSearch(config.braveSearchApiKey, verifier);
  const browse = new Browse(verifier);
  if (!config.braveSearchApiKey) console.warn('[config] BRAVE_SEARCH_API_KEY not set — web_search will return errors');

  // ── Per-client fleet construction ──────────────────────────────────────────

  const fleets = new Map<string, AgentFleet>();

  function buildFleet(clientId: string): AgentFleet {
    const clientConfig = config.clients.find((c) => c.id === clientId);
    if (!clientConfig) throw new Error(`Unknown client: ${clientId}`);

    const dataDir = clientDataDir(clientId);

    // Per-client: confirmations and event bus are fully isolated
    const confirmations = new Confirmations();
    const eventBus = new EventBus();

    const toolsRegistry = new ToolsRegistry(dataDir, clientConfig);
    toolsRegistry.init(dataDir);

    const registry = new AgentRegistry(toolsRegistry, eventBus, confirmations, config, clientConfig, dataDir);

    // Tools that need lazy registry reference (circular dep)
    const agentTools = new AgentTools(toolsRegistry.getAgentsDir(), () => registry, eventBus, toolsRegistry.topics);

    // Wire injectable deps into ToolsRegistry
    toolsRegistry.agentTools = agentTools;
    toolsRegistry.webSearch = webSearch;
    toolsRegistry.browse = browse;
    toolsRegistry.verifier = verifier;
    toolsRegistry.eventBusPublish = (e) => eventBus.publish(e);

    registry.load();

    // Wire Gmail tools if credentials exist (per-client)
    const credentialsPath = `${dataDir}/system/gmail-credentials.json`;
    const gmail = new GmailClient(credentialsPath);
    if (gmail.isConfigured()) {
      toolsRegistry.setGmailClient(gmail);
      console.log(`[gmail:${clientId}] tools enabled`);
    }

    const router = new AgentRouter(registry, eventBus);
    const fleet = new AgentFleet(registry, eventBus, router, config, clientConfig, toolsRegistry, confirmations);

    fleet.initBackgroundTasks();
    agentTools.onAgentCreated = (def) => fleet.initTasksForAgent(def);

    fleets.set(clientId, fleet);
    return fleet;
  }

  // Eager-init all enabled clients
  for (const client of enabledClients) {
    buildFleet(client.id);
  }

  if (enabledClients.length === 0) throw new Error('[config] No enabled clients configured');

  // Default fleet (first enabled client) for routes that don't specify clientId
  const defaultFleet = fleets.get(enabledClients[0]!.id)!;
  const defaultClientDataDir = clientDataDir(enabledClients[0]!.id);

  // ── Schedulers ─────────────────────────────────────────────────────────────

  const fleetScheduler = new AgentFleetScheduler([...fleets.values()]);
  fleetScheduler.start();

  // ── Hono app ───────────────────────────────────────────────────────────────

  const app = new Hono();
  app.use('*', cors());

  // Health
  app.get('/api/health', (c) => c.json({ status: 'ok' }));

  // API routes — pass defaultFleet for single-client compat; future: resolve per request
  app.route('/api', chatRoutes(defaultFleet, defaultFleet.getConfirmations()));
  app.route('/api', sessionRoutes(defaultFleet));
  app.route('/api', agentRoutes(defaultFleet));
  app.route('/api', eventRoutes(defaultFleet.getEventBus()));
  app.route('/api', toolsRoutes(defaultFleet));
  app.route('/api', artifactsRoutes(defaultFleet));
  app.route('/api', ccRoutes(config));
  app.route('/api', journalRoutes(defaultClientDataDir));

  console.log(`lifeos-ts server starting on port ${config.port}`);
  return { port: config.port, fetch: app.fetch, idleTimeout: 0 };
}

export default await createApp();
