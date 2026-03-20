import * as Chat from "./modules/chat.js";
import * as CC from "./modules/cc.js";
import * as Inspector from "./modules/inspector.js";
import * as AgentDebug from "./modules/agent-debug.js";
import * as EventsPanel from "./modules/events-panel.js";

// ── Helpers ───────────────────────────────────────────────────────────────────
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// ── Agent selection ───────────────────────────────────────────────────────────
let ACTIVE_AGENT = localStorage.getItem("chief-agent") || "cos";
const AGENT_TITLES = { cos: "Chief of Staff" };

const agentToggle = document.getElementById("agent-toggle");
const subAgentToggle = document.getElementById("sub-agent-toggle");

async function setActiveAgent(name, title) {
  ACTIVE_AGENT = name;
  localStorage.setItem("chief-agent", name);
  document.querySelectorAll(".agent-btn, .sub-agent-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.agent === name));
  inputEl.placeholder = `Talk to ${title}…`;

  // Restore this agent's last session if it's still open, otherwise open a new one
  const saved = localStorage.getItem(sessionKey(name));
  const openIds = await loadSessions();
  if (saved && openIds.has(saved)) {
    SESSION_ID = saved;
    Chat.reset(saved);
    await Chat.loadHistory(saved);
  } else {
    localStorage.removeItem(sessionKey(name));
    await openNewChat();
  }
}

function makeAgentSessionList(name) {
  const ul = document.createElement("ul");
  ul.className = "agent-session-list";
  ul.id = `sessions-${name}`;
  return ul;
}

function makeAgentRow(btn, agentName, agentTitle) {
  const row = document.createElement("div");
  row.className = "agent-row";
  const plus = document.createElement("button");
  plus.className = "agent-new-chat-btn";
  plus.textContent = "+";
  plus.title = `New ${agentTitle} chat`;
  plus.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (ACTIVE_AGENT !== agentName) {
      ACTIVE_AGENT = agentName;
      localStorage.setItem("chief-agent", agentName);
      document.querySelectorAll(".agent-btn, .sub-agent-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.agent === agentName));
      inputEl.placeholder = `Talk to ${agentTitle}…`;
    }
    await openNewChat();
    await loadSessions();
  });
  row.appendChild(btn);
  row.appendChild(plus);
  return row;
}

async function loadAgents() {
  try {
    // CoS is always hardcoded as the primary agent
    const cosBtn = document.createElement("button");
    cosBtn.className = "agent-btn" + (ACTIVE_AGENT === "cos" ? " active" : "");
    cosBtn.dataset.agent = "cos";
    cosBtn.textContent = "Chief of Staff";
    cosBtn.addEventListener("click", () => setActiveAgent("cos", "Chief of Staff"));
    agentToggle.innerHTML = "";
    agentToggle.appendChild(makeAgentRow(cosBtn, "cos", "Chief of Staff"));
    agentToggle.appendChild(makeAgentSessionList("cos"));

    // Dynamic agents load beneath
    const agents = await fetch("/api/agents").then(r => r.json());
    const subAgents = agents.filter(a => a.name !== "cos");
    subAgentToggle.innerHTML = "";
    subAgentToggle.style.display = subAgents.length ? "" : "none";
    document.getElementById("agent-separator").style.display = subAgents.length ? "" : "none";
    for (const { name, title } of subAgents) {
      const btn = document.createElement("button");
      btn.className = "sub-agent-btn" + (name === ACTIVE_AGENT ? " active" : "");
      btn.dataset.agent = name;
      btn.textContent = title;
      btn.addEventListener("click", () => setActiveAgent(name, title));
      subAgentToggle.appendChild(makeAgentRow(btn, name, title));
      subAgentToggle.appendChild(makeAgentSessionList(name));
    }

    // Populate title map
    for (const { name, title } of subAgents) AGENT_TITLES[name] = title;

    // Validate stored agent; fall back to cos if unknown
    const allAgents = [{ name: "cos", title: "Chief of Staff" }, ...subAgents];
    const current = allAgents.find(a => a.name === ACTIVE_AGENT);
    if (!current) setActiveAgent("cos", "Chief of Staff");
    else inputEl.placeholder = `Talk to ${current.title}…`;
  } catch (e) {
    console.error("Failed to load agents", e);
  }
}

// ── Session ───────────────────────────────────────────────────────────────────
function sessionKey(agent) { return `chief-session-${agent}`; }
let SESSION_ID = localStorage.getItem(sessionKey(ACTIVE_AGENT)) || null;

function setSession(sessionId) {
  SESSION_ID = sessionId;
  localStorage.setItem(sessionKey(ACTIVE_AGENT), sessionId);
}

const inputEl = document.getElementById("input");

// ── Sessions sidebar ──────────────────────────────────────────────────────────
async function loadSessions() {
  const openIds = new Set();
  try {
    const resp = await fetch("/api/sessions");
    const data = await resp.json();
    // Clear all per-agent session lists
    document.querySelectorAll(".agent-session-list").forEach(ul => ul.innerHTML = "");
    if (!data.sessions) return openIds;
    for (const s of data.sessions) {
      openIds.add(s.id);
      const agent = s.agent || "cos";
      const listEl = document.getElementById(`sessions-${agent}`);
      if (!listEl) continue;
      const li = document.createElement("li");
      li.className = "agent-session-item" + (s.id === SESSION_ID ? " active" : "");
      const ts = s.created_at > 0 ? new Date(s.created_at * 1000) : null;
      const dateStr = ts ? ts.toLocaleDateString("en-US", { month: "short", day: "numeric" })
        + " " + ts.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "";
      const time = document.createElement("span");
      time.className = "session-time";
      time.textContent = dateStr;
      const label = document.createElement("span");
      label.className = "session-label";
      label.textContent = s.title || s.id;
      const del = document.createElement("button");
      del.className = "session-delete-btn";
      del.textContent = "×";
      del.title = "Delete session";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        await fetch(`/api/sessions/${s.id}`, { method: "DELETE" });
        if (s.id === SESSION_ID) await openNewChat();
        await loadSessions();
      });
      li.appendChild(time);
      li.appendChild(label);
      li.appendChild(del);
      li.addEventListener("click", async () => {
        closeSidebar();
        ACTIVE_AGENT = s.agent || "cos";
        localStorage.setItem("chief-agent", ACTIVE_AGENT);
        document.querySelectorAll(".agent-btn, .sub-agent-btn").forEach(b =>
          b.classList.toggle("active", b.dataset.agent === ACTIVE_AGENT));
        setSession(s.id);
        Chat.reset(s.id);
        await Chat.loadHistory(s.id);
        await loadSessions();
        inputEl.focus();
      });
      listEl.appendChild(li);
    }
  } catch (e) {
    console.error("Failed to load sessions", e);
  }
  return openIds;
}

// ── New chat ──────────────────────────────────────────────────────────────────
async function openNewChat() {
  const resp = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: ACTIVE_AGENT }),
  });
  const data = await resp.json();
  setSession(data.session_id);
  Chat.reset(data.session_id);
  await loadSessions();
  inputEl.focus();
}

document.getElementById("new-chat-mobile").addEventListener("click", () => { closeSidebar(); openNewChat(); });

// ── Mobile sidebar ─────────────────────────────────────────────────────────────
const sidebar = document.getElementById("sidebar");
const overlay = document.getElementById("sidebar-overlay");
function openSidebar()  { sidebar.classList.add("open"); overlay.classList.add("open"); }
function closeSidebar() { sidebar.classList.remove("open"); overlay.classList.remove("open"); }
document.getElementById("hamburger").addEventListener("click", openSidebar);
overlay.addEventListener("click", closeSidebar);

// ── Agent Monitor view ────────────────────────────────────────────────────────
const agentMonitorEl = document.getElementById("agent-monitor");
const mainEl = document.getElementById("main");
const chatSidebarContent = document.getElementById("chat-sidebar-content");
const monitorSidebarContent = document.getElementById("monitor-sidebar-content");
let monitorInitialized = false;

const agentTabPanels = {
  runs:      document.getElementById("agents-runs-panel"),
  events:    document.getElementById("agents-events-panel"),
  inspector: document.getElementById("agents-inspector-panel"),
  cc:        document.getElementById("agents-cc-panel"),
};

function switchMonitorTab(tab) {
  document.querySelectorAll(".monitor-nav-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  Object.values(agentTabPanels).forEach(p => p.classList.add("hidden"));
  agentTabPanels[tab].classList.remove("hidden");
  if (tab === "cc") document.getElementById("cc-input").focus();
}

function showAgentMonitor() {
  mainEl.classList.add("hidden");
  agentMonitorEl.classList.remove("hidden");
  chatSidebarContent.classList.add("hidden");
  monitorSidebarContent.classList.remove("hidden");
  document.getElementById("agent-monitor-btn").classList.add("active");
  if (!monitorInitialized) {
    monitorInitialized = true;
    AgentDebug.load();
    EventsPanel.connect((event) => {
      if (event.type === "agent_run_end") AgentDebug.load();
    });
  }
}

function showChat() {
  agentMonitorEl.classList.add("hidden");
  mainEl.classList.remove("hidden");
  chatSidebarContent.classList.remove("hidden");
  monitorSidebarContent.classList.add("hidden");
  document.getElementById("agent-monitor-btn").classList.remove("active");
}

document.getElementById("agent-monitor-btn").addEventListener("click", () => {
  if (agentMonitorEl.classList.contains("hidden")) {
    showAgentMonitor();
  } else {
    showChat();
  }
});

document.querySelectorAll(".monitor-nav-btn").forEach(btn => {
  btn.addEventListener("click", () => { closeSidebar(); switchMonitorTab(btn.dataset.tab); });
});

document.querySelector(".sidebar-header h1").addEventListener("click", () => {
  if (!agentMonitorEl.classList.contains("hidden")) showChat();
});


// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  fetch("/api/sessions/prune", { method: "POST" }); // clean up empty sessions on load
  Inspector.init();
  await loadAgents();
  Chat.init(
    () => SESSION_ID,
    (newSessionId) => setSession(newSessionId),
    () => ACTIVE_AGENT,
    () => loadSessions(),
    () => AGENT_TITLES[ACTIVE_AGENT] || ACTIVE_AGENT,
  );
  CC.init();
  const openIds = await loadSessions();
  if (!SESSION_ID || !openIds.has(SESSION_ID)) {
    await openNewChat();
  } else {
    Chat.reset(SESSION_ID);
    await Chat.loadHistory(SESSION_ID);
  }
  await CC.loadHistory();

  // In-tab reminder listener — shows bubble when tab is open
  const reminderSource = new EventSource("/api/events");
  reminderSource.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      if (event.type === "reminder") {
        Chat.addMessage("agent", `⏰ ${event.message}`, null, Math.floor(Date.now() / 1000));
      } else if (event.type === "agents_updated") {
        loadAgents();
      }
    } catch {}
  };

  // Web Push — background notifications (works even when tab/browser is closed)
  if ("serviceWorker" in navigator && "PushManager" in window) {
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");
      console.log("[push] SW registered:", reg.scope);
      const permission = await Notification.requestPermission();
      console.log("[push] Notification permission:", permission);
      if (permission === "granted") {
        const existing = await reg.pushManager.getSubscription();
        if (existing) {
          console.log("[push] Already subscribed");
        } else {
          const { publicKey } = await fetch("/api/push/vapid-public-key").then(r => r.json());
          const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
          });
          const resp = await fetch("/api/push/subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(sub.toJSON()),
          });
          console.log("[push] Subscribed, server ack:", resp.ok);
        }
      }
    } catch (err) {
      console.warn("[push] Setup failed:", err);
    }
  } else {
    console.warn("[push] Not supported in this browser");
  }

  inputEl.focus();
})();
