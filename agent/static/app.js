/* lifeos frontend */

// ── Session ID — resumes last session if no local ID stored ──────────────────
let SESSION_ID = localStorage.getItem("lifeos-session-id") || null;

async function resolveSessionId() {
  if (SESSION_ID) return;
  // No local ID — try to resume the most recent persisted session from server
  try {
    const resp = await fetch("/api/chat/sessions");
    if (resp.ok) {
      const data = await resp.json();
      if (data.sessions && data.sessions.length > 0) {
        SESSION_ID = data.sessions[data.sessions.length - 1];
        localStorage.setItem("lifeos-session-id", SESSION_ID);
        return;
      }
    }
  } catch (_) {}
  // Nothing on server — start fresh
  SESSION_ID = "session-" + Math.random().toString(36).slice(2);
  localStorage.setItem("lifeos-session-id", SESSION_ID);
}

// ── Simple markdown renderer ─────────────────────────────────────────────────
function renderMarkdown(text) {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
      `<pre><code>${code.trim()}</code></pre>`)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>)/gs, "<ul>$1</ul>")
    .replace(/\n{2,}/g, "<br><br>")
    .replace(/\n/g, "<br>");
}

// ── JSON syntax highlighter ──────────────────────────────────────────────────
function highlightJson(obj) {
  const raw = JSON.stringify(obj, null, 2);
  return raw.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      if (/^"/.test(match)) {
        if (/:$/.test(match)) return `<span class="json-key">${match}</span>`;
        return `<span class="json-string">${match}</span>`;
      }
      if (/true|false/.test(match)) return `<span class="json-bool">${match}</span>`;
      if (/null/.test(match)) return `<span class="json-null">${match}</span>`;
      return `<span class="json-number">${match}</span>`;
    }
  );
}

// ── DOM helpers ──────────────────────────────────────────────────────────────
const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send-btn");
const projectListEl = document.getElementById("project-list");
const inspectorBody = document.getElementById("inspector-body");
const inspectorCopy = document.getElementById("inspector-copy");

let lastRequestPayload = null;
let pendingRequestPayload = null;

function makeSection(classes, label, meta, bodyHtml) {
  return `
    <div class="isp-section ${classes}">
      <div class="isp-head">
        <span class="isp-label">${label}</span>
        ${meta ? `<span class="isp-meta">${meta}</span>` : ""}
      </div>
      <div class="isp-body">${bodyHtml}</div>
    </div>`;
}

function updateInspector(reqPayload, resPayload) {
  lastRequestPayload = { request: reqPayload, response: resPayload };

  // Model — single value row
  const modelHtml = `<div class="isp-section model">
    <div class="isp-head"><span class="isp-label">Model</span></div>
    <div class="isp-model-val">${reqPayload.model}</div>
  </div>`;

  // System prompt
  const sysText = (reqPayload.system || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const sysChars = (reqPayload.system || "").length;
  const sysSection = makeSection("grow", "System Prompt", `${sysChars.toLocaleString()} chars`, sysText);

  // Tools
  const toolsMeta = `${(reqPayload.tools || []).length} tools`;
  const toolsSection = makeSection("grow", "Tools", toolsMeta, highlightJson(reqPayload.tools || []));

  // Messages
  const msgs = reqPayload.messages || [];
  const msgsMeta = `${msgs.length} turn${msgs.length !== 1 ? "s" : ""}`;
  const msgsSection = makeSection("grow-2", "Messages", msgsMeta, highlightJson(msgs));

  // Response
  const usage = resPayload.usage ? `${resPayload.usage.input_tokens} in / ${resPayload.usage.output_tokens} out` : "";
  const resMeta = [resPayload.stop_reason, usage].filter(Boolean).join(" · ");
  const resSection = makeSection("grow", "Response", resMeta, highlightJson(resPayload.content || []));

  inspectorBody.innerHTML = modelHtml + sysSection + toolsSection + msgsSection + resSection;
}

inspectorCopy.addEventListener("click", () => {
  if (!lastRequestPayload) return;
  navigator.clipboard.writeText(JSON.stringify(lastRequestPayload, null, 2));  // { request, response }
  inspectorCopy.textContent = "Copied!";
  setTimeout(() => { inspectorCopy.textContent = "Copy"; }, 1500);
});

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage(role, content) {
  const msg = document.createElement("div");
  msg.className = `msg ${role}`;
  const label = document.createElement("div");
  label.className = "msg-label";
  label.textContent = role === "user" ? "You" : "Agent";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (role === "agent") {
    bubble.innerHTML = renderMarkdown(content);
  } else {
    bubble.textContent = content;
  }
  msg.appendChild(label);
  msg.appendChild(bubble);
  messagesEl.appendChild(msg);
  scrollToBottom();
  return bubble;
}

function addTypingIndicator() {
  const msg = document.createElement("div");
  msg.className = "msg agent";
  msg.id = "typing";
  const label = document.createElement("div");
  label.className = "msg-label";
  label.textContent = "Agent";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  msg.appendChild(label);
  msg.appendChild(bubble);
  messagesEl.appendChild(msg);
  scrollToBottom();
  return msg;
}

function removeTypingIndicator() {
  const el = document.getElementById("typing");
  if (el) el.remove();
}

function addToolBlock(name, input) {
  const block = document.createElement("div");
  block.className = "tool-block";
  const nameEl = document.createElement("div");
  nameEl.className = "tool-name";
  nameEl.textContent = `⚙ ${name}`;
  const detail = document.createElement("div");
  detail.className = "tool-detail";
  detail.textContent = JSON.stringify(input, null, 2);
  block.appendChild(nameEl);
  block.appendChild(detail);
  return block;
}

// ── Load persisted history ───────────────────────────────────────────────────
async function loadHistory() {
  try {
    const resp = await fetch(`/api/chat/${SESSION_ID}`);
    if (!resp.ok) return;
    const data = await resp.json();
    for (const msg of data.messages) {
      const role = msg.role === "assistant" ? "agent" : "user";
      addMessage(role, msg.text);
    }
  } catch (e) {
    console.error("Failed to load history", e);
  }
}

// ── Chat ─────────────────────────────────────────────────────────────────────
let currentAgentBubble = null;
let currentAgentText = "";
let currentMsgEl = null;

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = "";
  inputEl.style.height = "auto";
  sendBtn.disabled = true;

  addMessage("user", text);
  addTypingIndicator();

  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: SESSION_ID, message: text }),
    });

    if (!resp.ok) throw new Error(`Server error: ${resp.status}`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    removeTypingIndicator();
    currentAgentText = "";
    currentAgentBubble = null;
    currentMsgEl = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;
        let event;
        try { event = JSON.parse(jsonStr); } catch { continue; }

        if (event.type === "request_json") {
          pendingRequestPayload = event.payload;
        } else if (event.type === "response_json") {
          if (pendingRequestPayload) {
            updateInspector(pendingRequestPayload, event.payload);
            pendingRequestPayload = null;
          }
        } else if (event.type === "text") {
          if (!currentMsgEl) {
            currentMsgEl = document.createElement("div");
            currentMsgEl.className = "msg agent";
            const label = document.createElement("div");
            label.className = "msg-label";
            label.textContent = "Agent";
            currentMsgEl.appendChild(label);
            messagesEl.appendChild(currentMsgEl);
          }
          if (!currentAgentBubble) {
            currentAgentBubble = document.createElement("div");
            currentAgentBubble.className = "bubble";
            currentMsgEl.appendChild(currentAgentBubble);
          }
          currentAgentText += event.text;
          currentAgentBubble.innerHTML = renderMarkdown(currentAgentText);
          scrollToBottom();
        } else if (event.type === "tool_call") {
          if (!currentMsgEl) {
            currentMsgEl = document.createElement("div");
            currentMsgEl.className = "msg agent";
            const label = document.createElement("div");
            label.className = "msg-label";
            label.textContent = "Agent";
            currentMsgEl.appendChild(label);
            messagesEl.appendChild(currentMsgEl);
          }
          const block = addToolBlock(event.name, event.input);
          currentMsgEl.appendChild(block);
          scrollToBottom();
        } else if (event.type === "tool_result") {
          if (["create_project", "update_project", "list_projects"].includes(event.name)) {
            loadProjects();
          }
        } else if (event.type === "done") {
          currentMsgEl = null;
          currentAgentBubble = null;
          currentAgentText = "";
        }
      }
    }
  } catch (err) {
    removeTypingIndicator();
    addMessage("agent", `Error: ${err.message}`);
  }

  sendBtn.disabled = false;
  inputEl.focus();
}

// ── Projects ─────────────────────────────────────────────────────────────────
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
      li.addEventListener("click", () => {
        inputEl.value = `Tell me about the "${p.name}" project`;
        inputEl.focus();
      });
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

// ── Input auto-resize + submit ────────────────────────────────────────────────
inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
});

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.addEventListener("click", sendMessage);

document.getElementById("clear-btn").addEventListener("click", async () => {
  await fetch(`/api/chat/${SESSION_ID}`, { method: "DELETE" });
  const newId = "session-" + Math.random().toString(36).slice(2);
  localStorage.setItem("lifeos-session-id", newId);
  location.reload();
});

// ── Sidecar tab switching ─────────────────────────────────────────────────────
const inspectorPanel = document.getElementById("inspector-panel");
const ccPanel = document.getElementById("cc-panel");
const eventsPanel = document.getElementById("events-panel");
const promptPanel = document.getElementById("prompt-panel");
const ispTabs = document.querySelectorAll(".isp-tab");

ispTabs.forEach(tab => {
  tab.addEventListener("click", () => {
    ispTabs.forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    const which = tab.dataset.tab;
    inspectorPanel.classList.add("hidden");
    ccPanel.classList.add("hidden");
    eventsPanel.classList.add("hidden");
    promptPanel.classList.add("hidden");
    inspectorCopy.style.display = "none";
    if (which === "inspector") {
      inspectorPanel.classList.remove("hidden");
      inspectorCopy.style.display = "";
    } else if (which === "cc") {
      ccPanel.classList.remove("hidden");
      ccInputEl.focus();
    } else if (which === "events") {
      eventsPanel.classList.remove("hidden");
    } else if (which === "prompt") {
      promptPanel.classList.remove("hidden");
    }

  });
});

// ── Claude Code chat ──────────────────────────────────────────────────────────
// Session ID is null until the first response comes back from Claude Code;
// from then on we --resume that exact session so it's fully isolated from
// any claude_code tool calls made by the main agent.
let CC_SESSION_ID = localStorage.getItem("lifeos-cc-session-id") || null;

const ccMessagesEl = document.getElementById("cc-messages");
const ccInputEl = document.getElementById("cc-input");
const ccSendBtn = document.getElementById("cc-send");

function ccScrollToBottom() {
  ccMessagesEl.scrollTop = ccMessagesEl.scrollHeight;
}

function addCCMessage(role, content) {
  const msg = document.createElement("div");
  msg.className = `cc-msg ${role}`;
  const label = document.createElement("div");
  label.className = "cc-label";
  label.textContent = role === "user" ? "You" : "Claude Code";
  const bubble = document.createElement("div");
  bubble.className = "cc-bubble";
  if (role === "cc") {
    bubble.innerHTML = renderMarkdown(content);
  } else {
    bubble.textContent = content;
  }
  msg.appendChild(label);
  msg.appendChild(bubble);
  ccMessagesEl.appendChild(msg);
  ccScrollToBottom();
  return bubble;
}

async function sendCCMessage() {
  const text = ccInputEl.value.trim();
  if (!text) return;
  ccInputEl.value = "";
  ccInputEl.style.height = "auto";
  ccSendBtn.disabled = true;

  addCCMessage("user", text);

  // Typing indicator
  const typingEl = document.createElement("div");
  typingEl.className = "cc-msg cc";
  typingEl.id = "cc-typing";
  const typingLabel = document.createElement("div");
  typingLabel.className = "cc-label";
  typingLabel.textContent = "Claude Code";
  const typingBubble = document.createElement("div");
  typingBubble.className = "cc-bubble";
  typingBubble.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  typingEl.appendChild(typingLabel);
  typingEl.appendChild(typingBubble);
  ccMessagesEl.appendChild(typingEl);
  ccScrollToBottom();

  let ccText = "";
  let ccBubble = null;
  let ccMsgEl = null;

  try {
    const resp = await fetch("/api/cc/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, session_id: CC_SESSION_ID }),
    });

    if (!resp.ok) throw new Error(`Server error: ${resp.status}`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // NOTE: do NOT remove typingEl here — remove it only when the first real
    // event arrives so it stays visible during the subprocess startup delay.

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;
        let event;
        try { event = JSON.parse(jsonStr); } catch { continue; }

        if (event.type === "text") {
          // Remove typing indicator on first real text chunk
          if (!ccMsgEl) {
            const t = document.getElementById("cc-typing");
            if (t) t.remove();
            ccMsgEl = document.createElement("div");
            ccMsgEl.className = "cc-msg cc";
            const lbl = document.createElement("div");
            lbl.className = "cc-label";
            lbl.textContent = "Claude Code";
            ccBubble = document.createElement("div");
            ccBubble.className = "cc-bubble";
            ccMsgEl.appendChild(lbl);
            ccMsgEl.appendChild(ccBubble);
            ccMessagesEl.appendChild(ccMsgEl);
          }
          ccText += event.text;
          ccBubble.innerHTML = renderMarkdown(ccText);
          ccScrollToBottom();
        } else if (event.type === "session_id") {
          CC_SESSION_ID = event.session_id;
          localStorage.setItem("lifeos-cc-session-id", CC_SESSION_ID);
        } else if (event.type === "error") {
          const t = document.getElementById("cc-typing");
          if (t) t.remove();
          addCCMessage("cc", `⚠ ${event.text}`);
        }
        // "done" — typing indicator already gone by this point
      }
    }
    // Ensure typing indicator is always cleaned up even if no events came
    const t = document.getElementById("cc-typing");
    if (t) t.remove();
  } catch (err) {
    const t = document.getElementById("cc-typing");
    if (t) t.remove();
    addCCMessage("cc", `⚠ Error: ${err.message}`);
  }

  ccSendBtn.disabled = false;
  ccInputEl.focus();
}

ccSendBtn.addEventListener("click", sendCCMessage);

ccInputEl.addEventListener("input", () => {
  ccInputEl.style.height = "auto";
  ccInputEl.style.height = Math.min(ccInputEl.scrollHeight, 120) + "px";
});

ccInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendCCMessage();
  }
});

// ── Load CC history ───────────────────────────────────────────────────────────
async function loadCCHistory() {
  if (!CC_SESSION_ID) return;
  try {
    const resp = await fetch(`/api/cc/history?session_id=${CC_SESSION_ID}`);
    if (!resp.ok) return;
    const data = await resp.json();
    for (const msg of data.messages) {
      addCCMessage(msg.role, msg.text);
    }
  } catch (e) {
    console.error("Failed to load CC history", e);
  }
}

// ── Prompt parts editor ───────────────────────────────────────────────────────
const promptFileList = document.getElementById("prompt-file-list");
const promptEditor = document.getElementById("prompt-editor");
const promptSaveBtn = document.getElementById("prompt-save-btn");
const promptSaveStatus = document.getElementById("prompt-save-status");
let activePromptFile = null;

async function loadPromptParts() {
  const resp = await fetch("/api/prompt-parts");
  const data = await resp.json();
  promptFileList.innerHTML = "";
  for (const name of data.parts) {
    const btn = document.createElement("button");
    btn.className = "prompt-file-btn";
    btn.textContent = name;
    btn.addEventListener("click", () => selectPromptFile(name));
    promptFileList.appendChild(btn);
  }
  if (data.parts.length > 0) selectPromptFile(data.parts[0]);
}

async function selectPromptFile(name) {
  activePromptFile = name;
  promptFileList.querySelectorAll(".prompt-file-btn").forEach(b => {
    b.classList.toggle("active", b.textContent === name);
  });
  const resp = await fetch(`/api/prompt-parts/${name}`);
  const data = await resp.json();
  promptEditor.value = data.content;
  promptSaveStatus.textContent = "";
}

promptSaveBtn.addEventListener("click", async () => {
  if (!activePromptFile) return;
  promptSaveBtn.disabled = true;
  const resp = await fetch(`/api/prompt-parts/${activePromptFile}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: promptEditor.value }),
  });
  promptSaveBtn.disabled = false;
  promptSaveStatus.textContent = resp.ok ? "Saved" : "Error";
  setTimeout(() => { promptSaveStatus.textContent = ""; }, 2000);
});

// ── Events stream ─────────────────────────────────────────────────────────────
const eventsBody = document.getElementById("events-body");

function appendEvent(event) {
  const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const row = document.createElement("div");
  row.className = `ev-row ev-${event.type.replace(/_/g, "-")}`;

  let badge = event.type;
  let detail = "";

  if (event.type === "boot_start") {
    badge = "boot"; detail = "Boot sequence started";
  } else if (event.type === "boot_done") {
    badge = "boot"; detail = "Boot complete";
  } else if (event.type === "knowledge_file") {
    badge = "knowledge"; detail = `${event.file} — ${event.status}${event.chars ? ` (${event.chars.toLocaleString()} chars)` : ""}`;
  } else if (event.type === "onboarding_status") {
    badge = "onboarding"; detail = `${event.file} — ${event.status}`;
  } else if (event.type === "system_prompt") {
    badge = "prompt"; detail = `System prompt assembled (${event.chars.toLocaleString()} chars)`;
  } else if (event.type === "session_start") {
    badge = "session"; detail = `Session started — ${event.session_id}`;
  } else if (event.type === "session_end") {
    badge = "session"; detail = `Session ended — ${event.session_id}`;
  } else if (event.type === "llm_request") {
    badge = "llm"; detail = `→ ${event.model} (${event.messages} messages)`;
  } else if (event.type === "llm_response") {
    badge = "llm"; detail = `← ${event.stop_reason} · ${event.input_tokens} in / ${event.output_tokens} out`;
  } else if (event.type === "tool_use") {
    badge = "tool_use"; detail = `${event.name} — Claude requested`;
  } else if (event.type === "tool_call") {
    badge = "tool"; detail = `${event.name}(${JSON.stringify(event.input)})`;
  } else if (event.type === "tool_result") {
    badge = "result"; detail = `${event.name} → ${JSON.stringify(event.result).slice(0, 120)}`;
  } else if (event.type === "knowledge_updated") {
    badge = "write"; detail = `${event.file} updated (${event.chars.toLocaleString()} chars)`;
  } else if (event.type === "onboarding_updated") {
    badge = "onboarding"; detail = `${event.file} marked ${event.status}`;
  } else if (event.type === "onboarding_complete") {
    badge = "onboarding"; detail = "Onboarding complete";
  } else if (event.type === "prompt_part_updated") {
    badge = "prompt"; detail = `${event.name} updated (${event.chars.toLocaleString()} chars)`;
  } else if (event.type === "cc_request") {
    badge = "cc"; detail = `→ ${event.message.slice(0, 80)}`;
  } else if (event.type === "cc_response") {
    badge = "cc"; detail = `← ${event.chars.toLocaleString()} chars · session ${event.session_id?.slice(0, 8)}`;
  } else {
    detail = JSON.stringify(event);
  }

  row.innerHTML = `<span class="ev-ts">${ts}</span><span class="ev-badge">${badge}</span><span class="ev-detail">${detail}</span>`;
  eventsBody.appendChild(row);
  eventsBody.scrollTop = eventsBody.scrollHeight;
}

async function connectEventStream() {
  try {
    const resp = await fetch("/api/events");
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;
        try { appendEvent(JSON.parse(jsonStr)); } catch { }
      }
    }
  } catch (e) {
    console.error("Event stream disconnected", e);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  await resolveSessionId();
  await loadHistory();
  await loadProjects();
  await loadCCHistory();
  await loadPromptParts();
  connectEventStream();
  inputEl.focus();
})();
