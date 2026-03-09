import * as Chat from "./modules/chat.js";
import * as CC from "./modules/cc.js";
import * as Inspector from "./modules/inspector.js";
import * as EventsPanel from "./modules/events-panel.js";
import * as Prompt from "./modules/prompt.js";

// ── Conversation + Session ────────────────────────────────────────────────────
let CONV_ID = localStorage.getItem("lifeos-conv-id") || null;
let SESSION_ID = localStorage.getItem("lifeos-session-id") || null;

function setConversation(convId, sessionId) {
  CONV_ID = convId;
  SESSION_ID = sessionId;
  localStorage.setItem("lifeos-conv-id", convId);
  localStorage.setItem("lifeos-session-id", sessionId);
}

// ── Projects ──────────────────────────────────────────────────────────────────
const projectListEl = document.getElementById("project-list");
const inputEl = document.getElementById("input");

async function openProjectConversation(projectName) {
  const resp = await fetch("/api/conversations/for-project", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_name: projectName }),
  });
  const data = await resp.json();
  setConversation(data.conv_id, data.session_id);
  Chat.reset(data.conv_id, data.session_id);
  await Chat.loadHistory(data.conv_id, data.session_id);
  await loadConversations();
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
      li.addEventListener("click", () => openProjectConversation(p.name));
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
  inputEl.value = `Show me my ${link.dataset.file} knowledge file`;
  inputEl.focus();
});

// ── Conversations sidebar ─────────────────────────────────────────────────────
const convListEl = document.getElementById("conv-list");

async function loadConversations() {
  try {
    const resp = await fetch("/api/conversations");
    const data = await resp.json();
    convListEl.innerHTML = "";
    if (!data.conversations || data.conversations.length === 0) {
      convListEl.innerHTML = '<li class="empty">No conversations yet</li>';
      return;
    }
    for (const c of [...data.conversations].reverse()) {
      const li = document.createElement("li");
      li.className = "project-item" + (c.id === CONV_ID ? " active-conv" : "");
      li.textContent = c.name.replace(/-/g, " ");
      li.addEventListener("click", async () => {
        setConversation(c.id, c.current_session);
        Chat.reset(c.id, c.current_session);
        await Chat.loadHistory(c.id, c.current_session);
        await loadConversations();
        inputEl.focus();
      });
      convListEl.appendChild(li);
    }
  } catch (e) {
    console.error("Failed to load conversations", e);
  }
}

// ── Main conversation ─────────────────────────────────────────────────────────
async function openMainConversation() {
  const resp = await fetch("/api/conversations/main");
  const data = await resp.json();
  setConversation(data.conv_id, data.session_id);
  Chat.reset(data.conv_id, data.session_id);
  await Chat.loadHistory(data.conv_id, data.session_id);
  inputEl.focus();
}

document.getElementById("main-conv-btn").addEventListener("click", (e) => {
  e.preventDefault();
  openMainConversation();
});

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
  });
});

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  Inspector.init();
  Chat.init(
    () => ({ convId: CONV_ID, sessionId: SESSION_ID }),
    loadProjects,
    (newSessionId) => setConversation(CONV_ID, newSessionId),
  );
  CC.init();
  Prompt.init();
  if (!CONV_ID || !SESSION_ID) {
    await openMainConversation();
  } else {
    await Chat.loadHistory(CONV_ID, SESSION_ID);
  }
  await loadProjects();
  await loadConversations();
  await CC.loadHistory();
  await Prompt.load();
  EventsPanel.connect();
  inputEl.focus();
})();
