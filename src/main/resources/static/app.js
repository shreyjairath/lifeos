import * as Chat from "./modules/chat.js";
import * as CC from "./modules/cc.js";
import * as Inspector from "./modules/inspector.js";
import * as EventsPanel from "./modules/events-panel.js";
import * as Prompt from "./modules/prompt.js";

// ── Session ───────────────────────────────────────────────────────────────────
let SESSION_ID = localStorage.getItem("lifeos-session-id") || null;

function setSession(sessionId) {
  SESSION_ID = sessionId;
  localStorage.setItem("lifeos-session-id", sessionId);
}

// ── Projects ──────────────────────────────────────────────────────────────────
const projectListEl = document.getElementById("project-list");
const inputEl = document.getElementById("input");

async function openProjectSession(projectName) {
  const resp = await fetch("/api/sessions/for-project", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_name: projectName }),
  });
  const data = await resp.json();
  setSession(data.session_id);
  Chat.reset(data.session_id);
  await Chat.loadHistory(data.session_id);
  await loadSessions();
  inputEl.value = "";
  inputEl.focus();
}

async function loadProjects() {
  try {
    const resp = await fetch("/api/projects");
    const data = await resp.json();
    projectListEl.innerHTML = "";
    if (!data.projects || data.projects.length === 0) {
      projectListEl.innerHTML = '<li class="empty">No projects yet</li>';
      return;
    }
    for (const p of data.projects) {
      const li = document.createElement("li");
      li.className = "project-item";
      li.innerHTML = `<div>${p.name.replace(/-/g, " ")}</div><div class="project-status">${p.status}</div>`;
      li.addEventListener("click", () => { closeSidebar(); openProjectSession(p.name); });
      projectListEl.appendChild(li);
    }
  } catch (e) {
    console.error("Failed to load projects", e);
  }
}

// ── Knowledge links ───────────────────────────────────────────────────────────
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
  Chat.init(
    () => SESSION_ID,
    loadProjects,
    (newSessionId) => setSession(newSessionId),
  );
  CC.init();
  Prompt.init();
  if (!SESSION_ID) {
    await openNewChat();
  } else {
    await Chat.loadHistory(SESSION_ID);
  }
  await loadProjects();
  await loadSessions();
  await CC.loadHistory();
  await Prompt.load();
  EventsPanel.connect();
  inputEl.focus();
})();
