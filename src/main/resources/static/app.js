import * as Chat from "./modules/chat.js";
import * as CC from "./modules/cc.js";
import * as AgentDebug from "./modules/agent-debug.js";
import * as AgentChannels from "./modules/agent-channels.js";

// ── iOS Safari viewport height fix ───────────────────────────────────────────
// CSS vh/dvh units include area under Safari chrome; window.innerHeight does not.
function updateVH() {
  document.documentElement.style.setProperty("--vh", window.innerHeight * 0.01 + "px");
}
updateVH();
window.addEventListener("resize", updateVH);

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
const AGENT_MODELS = {};

const agentToggle = document.getElementById("agent-toggle");
const subAgentToggle = document.getElementById("sub-agent-toggle");

function updateModelPlaceholder(agentName) {
  if (!modelInputEl.value.trim()) {
    modelInputEl.placeholder = AGENT_MODELS[agentName] || "Model override…";
  }
}

function closeArtifactPanel() {
  document.getElementById("app").classList.remove("artifact-open");
  const iframe = document.getElementById("artifact-iframe");
  iframe.srcdoc = "";
  iframe.src = "";
  document.getElementById("artifact-title").textContent = "Artifact";
  document.getElementById("artifact-browser")?.classList.add("hidden");
}

async function setActiveAgent(name, title) {
  ACTIVE_AGENT = name;
  localStorage.setItem("chief-agent", name);
  document.querySelectorAll(".agent-btn, .sub-agent-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.agent === name));
  inputEl.placeholder = `Talk to ${title}…`;
  updateModelPlaceholder(name);
  closeArtifactPanel();

  // Restore this agent's last session if it's still open, otherwise open a new one
  const saved = localStorage.getItem(sessionKey(name));
  const { openIds } = await loadSessions();
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
      updateModelPlaceholder(agentName);
      closeArtifactPanel();
    }
    await openNewChat();
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
    const subAgents = agents.filter(a => a.name !== "cos" && !a.disabledModes?.includes("chat"));
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

    // Populate title + model maps
    for (const { name, title, effectiveModel } of agents) {
      AGENT_TITLES[name] = title;
      if (effectiveModel) AGENT_MODELS[name] = effectiveModel;
    }

    // Validate stored agent; fall back to cos if unknown
    const allAgents = [{ name: "cos", title: "Chief of Staff" }, ...subAgents];
    const current = allAgents.find(a => a.name === ACTIVE_AGENT);
    if (!current) setActiveAgent("cos", "Chief of Staff");
    else {
      inputEl.placeholder = `Talk to ${current.title}…`;
      updateModelPlaceholder(current.name);
    }
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
const modelInputEl = document.getElementById("model-input");
modelInputEl.value = localStorage.getItem("chief-model") || "";
modelInputEl.addEventListener("input", () => {
  const v = modelInputEl.value.trim();
  localStorage.setItem("chief-model", v);
  modelInputEl.placeholder = v ? "Model override…" : (AGENT_MODELS[ACTIVE_AGENT] || "Model override…");
});

// ── Sessions sidebar ──────────────────────────────────────────────────────────

function sessionRelTime(epochSec) {
  const diff = Math.floor(Date.now() / 1000) - epochSec;
  if (diff < 60)    return "now";
  if (diff < 3600)  return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  const d = new Date(epochSec * 1000);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtTok(n) {
  if (!n || n === 0) return "";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

async function loadSessions() {
  const openIds = new Set();
  const sessions = [];
  try {
    const resp = await fetch("/api/sessions");
    const data = await resp.json();
    // Clear all per-agent session lists
    document.querySelectorAll(".agent-session-list").forEach(ul => ul.innerHTML = "");
    if (!data.sessions) return { openIds, sessions };
    for (const s of data.sessions) {
      openIds.add(s.id);
      sessions.push(s);
      const agent = s.agent || "cos";
      const listEl = document.getElementById(`sessions-${agent}`);
      if (!listEl) continue;
      const li = document.createElement("li");
      li.className = "agent-session-item" + (s.id === SESSION_ID ? " active" : "");
      const refEpoch = s.last_message_at > 0 ? s.last_message_at : s.created_at;
      const time = document.createElement("span");
      time.className = "session-time";
      time.textContent = refEpoch > 0 ? sessionRelTime(refEpoch) : "";
      time.title = refEpoch > 0 ? new Date(refEpoch * 1000).toLocaleString() : "";
      const label = document.createElement("span");
      label.className = "session-label";
      label.textContent = s.title || s.id;
      const tok = document.createElement("span");
      tok.className = "session-tokens";
      tok.textContent = fmtTok(s.last_input_tokens);
      const del = document.createElement("button");
      del.className = "session-delete-btn";
      del.textContent = "×";
      del.title = "Delete session";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Delete this session?")) return;
        await fetch(`/api/sessions/${s.agent || "cos"}/${s.id}`, { method: "DELETE" });
        if (s.id === SESSION_ID) {
          const { sessions: remaining } = await loadSessions();
          const next = remaining.find(r => r.agent === ACTIVE_AGENT);
          if (next) {
            setSession(next.id);
            Chat.reset(next.id);
            await Chat.loadHistory(next.id);
            await loadSessions();
          } else {
            SESSION_ID = null;
            localStorage.removeItem(sessionKey(ACTIVE_AGENT));
            Chat.reset(null);
            await loadSessions();
          }
        } else {
          await loadSessions();
        }
      });
      li.appendChild(time);
      li.appendChild(label);
      li.appendChild(tok);
      li.appendChild(del);
      li.addEventListener("click", async () => {
        closeSidebar();
        closeArtifactPanel();
        ACTIVE_AGENT = s.agent || "cos";
        localStorage.setItem("chief-agent", ACTIVE_AGENT);
        document.querySelectorAll(".agent-btn, .sub-agent-btn").forEach(b =>
          b.classList.toggle("active", b.dataset.agent === ACTIVE_AGENT));
        inputEl.placeholder = `Talk to ${AGENT_TITLES[ACTIVE_AGENT] || ACTIVE_AGENT}…`;
        updateModelPlaceholder(ACTIVE_AGENT);
        setSession(s.id);
        Chat.reset(s.id);
        await Chat.loadHistory(s.id);
        document.querySelectorAll(".agent-session-item").forEach(el => el.classList.remove("active"));
        li.classList.add("active");
        inputEl.focus();
      });
      listEl.appendChild(li);
    }
  } catch (e) {
    console.error("Failed to load sessions", e);
  }
  return { openIds, sessions };
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
  runs:     document.getElementById("agents-runs-panel"),
  channels: document.getElementById("agents-channels-panel"),
  cc:       document.getElementById("agents-cc-panel"),
};

let channelsInitialized = false;

function switchMonitorTab(tab) {
  document.querySelectorAll(".monitor-nav-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  Object.values(agentTabPanels).forEach(p => p.classList.add("hidden"));
  agentTabPanels[tab].classList.remove("hidden");
  if (tab === "cc") document.getElementById("cc-input").focus();
  if (tab === "channels" && !channelsInitialized) {
    channelsInitialized = true;
    AgentChannels.load();
  }
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
  btn.addEventListener("click", () => {
    switchMonitorTab(btn.classList.contains("active") ? "runs" : btn.dataset.tab);
  });
});

document.querySelector(".sidebar-header h1").addEventListener("click", () => {
  if (!agentMonitorEl.classList.contains("hidden")) showChat();
});


// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  fetch("/api/sessions/prune", { method: "POST" }); // clean up empty sessions on load
  await loadAgents();
  Chat.init(
    () => SESSION_ID,
    (newSessionId) => setSession(newSessionId),
    () => ACTIVE_AGENT,
    () => loadSessions(),
    () => AGENT_TITLES[ACTIVE_AGENT] || ACTIVE_AGENT,
    () => modelInputEl.value.trim(),
  );
  CC.init();
  const { openIds } = await loadSessions();
  if (!SESSION_ID || !openIds.has(SESSION_ID)) {
    await openNewChat();
  } else {
    Chat.reset(SESSION_ID);
    await Chat.loadHistory(SESSION_ID);
  }
  await CC.loadHistory();

  document.getElementById("artifacts-btn")?.addEventListener("click", () => {
    document.getElementById("app").classList.add("artifact-open");
    document.getElementById("artifact-browse")?.click();
  });

  // In-tab reminder listener — shows bubble when tab is open
  const reminderSource = new EventSource("/api/events");
  reminderSource.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      if (event.type === "reminder") {
        Chat.addMessage("agent", `⏰ ${event.message}`, null, Math.floor(Date.now() / 1000));
      } else if (event.type === "agents_updated") {
        loadAgents().then(() => loadSessions());
      } else if (event.type === "artifact_updated" && event.agent === ACTIVE_AGENT) {
        Chat.showArtifact(event.url, event.title);
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
