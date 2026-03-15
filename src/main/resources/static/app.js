import * as Chat from "./modules/chat.js";
import * as CC from "./modules/cc.js";
import * as Inspector from "./modules/inspector.js";
import * as EventsPanel from "./modules/events-panel.js";
import * as Prompt from "./modules/prompt.js";

// ── Helpers ───────────────────────────────────────────────────────────────────
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// ── Agent selection ───────────────────────────────────────────────────────────
let ACTIVE_AGENT = localStorage.getItem("lifeos-agent") || "main";

document.querySelectorAll(".agent-btn").forEach(btn => {
  btn.classList.toggle("active", btn.dataset.agent === ACTIVE_AGENT);
  btn.addEventListener("click", () => {
    ACTIVE_AGENT = btn.dataset.agent;
    localStorage.setItem("lifeos-agent", ACTIVE_AGENT);
    document.querySelectorAll(".agent-btn").forEach(b => b.classList.toggle("active", b === btn));
    inputEl.placeholder = ACTIVE_AGENT === "therapist" ? "Talk to your therapist…" : "Ask your agent anything…";
  });
});

// ── Session ───────────────────────────────────────────────────────────────────
let SESSION_ID = localStorage.getItem("lifeos-session-id") || null;

function setSession(sessionId) {
  SESSION_ID = sessionId;
  localStorage.setItem("lifeos-session-id", sessionId);
}

// ── Knowledge links ───────────────────────────────────────────────────────────
const inputEl = document.getElementById("input");
document.getElementById("knowledge-list").addEventListener("click", (e) => {
  const link = e.target.closest("[data-file]");
  if (!link) return;
  e.preventDefault();
  inputEl.value = `Show me my agent notes`;
  inputEl.focus();
});

// ── Sessions sidebar ──────────────────────────────────────────────────────────
const convListEl = document.getElementById("conv-list");

async function loadSessions() {
  try {
    const resp = await fetch("/api/sessions");
    const data = await resp.json();
    convListEl.innerHTML = "";
    if (!data.sessions || data.sessions.length === 0) {
      convListEl.innerHTML = '<li class="empty">No sessions yet</li>';
      return;
    }
    for (const s of [...data.sessions].reverse().slice(0, 3)) {
      const li = document.createElement("li");
      li.className = "project-item" + (s.id === SESSION_ID ? " active-conv" : "");
      li.textContent = s.title || s.name;
      li.addEventListener("click", async () => {
        closeSidebar();
        setSession(s.id);
        Chat.reset(s.id);
        await Chat.loadHistory(s.id);
        await loadSessions();
        inputEl.focus();
      });
      convListEl.appendChild(li);
    }
  } catch (e) {
    console.error("Failed to load sessions", e);
  }
}

// ── New chat ──────────────────────────────────────────────────────────────────
async function openNewChat() {
  const resp = await fetch("/api/sessions", { method: "POST" });
  const data = await resp.json();
  setSession(data.session_id);
  Chat.reset(data.session_id);
  await loadSessions();
  inputEl.focus();
}

document.getElementById("new-chat-btn").addEventListener("click", openNewChat);
document.getElementById("new-chat-mobile").addEventListener("click", () => { closeSidebar(); openNewChat(); });

// ── Mobile sidebar ─────────────────────────────────────────────────────────────
const sidebar = document.getElementById("sidebar");
const overlay = document.getElementById("sidebar-overlay");
function openSidebar()  { sidebar.classList.add("open"); overlay.classList.add("open"); }
function closeSidebar() { sidebar.classList.remove("open"); overlay.classList.remove("open"); }
document.getElementById("hamburger").addEventListener("click", openSidebar);
overlay.addEventListener("click", closeSidebar);

// ── Sidecar tab switching ─────────────────────────────────────────────────────
const PANELS = {
  inspector: document.getElementById("inspector-panel"),
  cc:        document.getElementById("cc-panel"),
  events:    document.getElementById("events-panel"),
  prompt:    document.getElementById("prompt-panel"),
};
const inspectorCopy = document.getElementById("inspector-copy");
const ispTabs = document.querySelectorAll(".isp-tab");

ispTabs.forEach(tab => {
  tab.addEventListener("click", () => {
    ispTabs.forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    const which = tab.dataset.tab;
    Object.values(PANELS).forEach(p => p.classList.add("hidden"));
    inspectorCopy.style.display = "none";
    if (PANELS[which]) PANELS[which].classList.remove("hidden");
    if (which === "inspector") inspectorCopy.style.display = "";
    if (which === "cc") document.getElementById("cc-input").focus();
    if (which === "prompt") Prompt.load();
  });
});

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  Inspector.init();
  inputEl.placeholder = ACTIVE_AGENT === "therapist" ? "Talk to your therapist…" : "Ask your agent anything…";
  Chat.init(
    () => SESSION_ID,
    (newSessionId) => setSession(newSessionId),
    () => ACTIVE_AGENT,
    () => loadSessions(),
  );
  CC.init();
  Prompt.init();
  if (!SESSION_ID) {
    await openNewChat();
  } else {
    await Chat.loadHistory(SESSION_ID);
  }
  await loadSessions();
  await CC.loadHistory();
  await Prompt.load();
  EventsPanel.connect();

  // In-tab reminder listener — shows bubble when tab is open
  const reminderSource = new EventSource("/api/events");
  reminderSource.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      if (event.type === "reminder") {
        Chat.addMessage("agent", `⏰ ${event.message}`, null, Math.floor(Date.now() / 1000));
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
