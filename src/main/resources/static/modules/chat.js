import { renderMarkdown } from "./utils.js";
import * as Voice from "./voice.js";

const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send-btn");
const stopBtn = document.getElementById("stop-btn");

function setAgentRunning(running) {
  sendBtn.disabled = running;
  if (stopBtn) stopBtn.style.display = running ? "inline-flex" : "none";
}

let currentAgentBubble = null;
let currentAgentText = "";
let currentReasoningText = "";
let currentReasoningEl = null;
let currentMsgEl = null;
let currentToolBlock = null;
let currentAgentThreadEl = null;
let historyIndex = 0;
let _getSessionId = () => null;
let _onRotate = (_newSessionId) => {};
let _onDone = () => {};
let _getAgent = () => "main";
let _getAgentTitle = () => "Agent";
let _getModel = () => "";

let _pinnedToBottom = true;

messagesEl.addEventListener("scroll", () => {
  const distFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  _pinnedToBottom = distFromBottom < 80;
});

function scrollToBottom() {
  if (_pinnedToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function rewindTo(msgEl, fromIndex) {
  const sessionId = _getSessionId();
  await fetch(`/api/chat/${_getAgent()}/${sessionId}/truncate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ index: fromIndex }),
  });
  while (messagesEl.lastChild && messagesEl.lastChild !== msgEl) {
    messagesEl.removeChild(messagesEl.lastChild);
  }
  messagesEl.removeChild(msgEl);
  historyIndex = fromIndex;
}

function formatTs(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
      d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function addMessage(role, content, msgIndex, ts) {
  const msg = document.createElement("div");
  msg.className = `msg ${role}`;

  const header = document.createElement("div");
  header.className = "msg-header";

  const label = document.createElement("div");
  label.className = "msg-label";
  label.textContent = role === "user" ? "You" : _getAgentTitle();
  header.appendChild(label);

  if (ts) {
    const time = document.createElement("span");
    time.className = "msg-ts";
    time.textContent = formatTs(ts);
    header.appendChild(time);
  }

  if (role === "user" && msgIndex !== undefined) {
    const rewindBtn = document.createElement("button");
    rewindBtn.className = "rewind-btn";
    rewindBtn.title = "Rewind to here";
    rewindBtn.textContent = "↩";
    rewindBtn.addEventListener("click", () => rewindTo(msg, msgIndex));
    header.appendChild(rewindBtn);
  }

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (role === "agent") {
    bubble.innerHTML = renderMarkdown(content);
  } else {
    bubble.textContent = content;
  }
  msg.appendChild(header);
  msg.appendChild(bubble);
  messagesEl.appendChild(msg);
  scrollToBottom();
  return bubble;
}

export function addTypingIndicator() {
  removeTypingIndicator();
  const msg = document.createElement("div");
  msg.className = "msg agent";
  msg.id = "typing";
  const label = document.createElement("div");
  label.className = "msg-label";
  label.textContent = _getAgentTitle();
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  msg.appendChild(label);
  msg.appendChild(bubble);
  messagesEl.appendChild(msg);
  scrollToBottom();
  return msg;
}

export function removeTypingIndicator() {
  const el = document.getElementById("typing");
  if (el) el.remove();
}

function toolSummary(name, input) {
  switch (name) {
    case "agent_bash":            return `$ ${input.command}`;
    case "web_search":            return `web_search  "${input.query}"`;
    case "browse_page":           return `browse_page  ${input.url}`;
    case "get_current_datetime":  return `get_current_datetime`;
    case "set_reminder":          return `set_reminder  ${input.time}  "${input.message}"`;
    case "list_reminders":        return `list_reminders`;
    case "delete_reminder":       return `delete_reminder  ${input.id}`;
    case "schedule_task":         return `schedule_task  ${input.name}`;
    case "get_scheduled_tasks":   return `get_scheduled_tasks`;
    case "get_overdue_tasks":     return `get_overdue_tasks`;
    case "mark_task_complete":    return `mark_task_complete  ${input.id}`;
    case "log_entry":             return `log_entry  ${input.mode}`;
    case "read_log":              return `read_log`;
    case "list_sessions":         return `list_sessions`;
    case "read_session_summary":  return `read_session_summary  ${input.session_id}`;
    case "read_session_transcript": return `read_session_transcript  ${input.session_id}`;
    case "message_agent": {
      const msg = input.message ?? "";
      const preview = msg.length > 50 ? msg.slice(0, 50) + "…" : msg;
      return `message_agent  ${input.agent}  "${preview}"`;
    }
    case "message_agent_async": {
      const msg = input.message ?? "";
      const preview = msg.length > 50 ? msg.slice(0, 50) + "…" : msg;
      return `message_agent_async  ${input.agent}  "${preview}"`;
    }
    case "read_agent_message_history": return `read_agent_message_history  ${input.agent}`;
    case "read_agent_workspace":  return `read_agent_workspace  ${input.agent}  $ ${input.command}`;
    case "read_agent_definition": return `read_agent_definition  ${input.agent}`;
    case "list_agents":           return `list_agents`;
    case "list_tools":            return `list_tools`;
    case "create_agent":          return `create_agent  ${input.name}`;
    case "update_agent":          return `update_agent  ${input.name}`;
    case "parse_redfin_search":   return `parse_redfin_search  ${input.url}`;
    case "parse_redfin_listing":  return `parse_redfin_listing  ${input.url}`;
    case "show_image":            return `show_image  ${input.url}`;
    case "property_report":       return `property_report  ${input.address}`;
    case "render_artifact":       return `render_artifact  ${input.title || input.path}`;
    default:                      return name;
  }
}

function addToolBlock(name, input) {
  const block = document.createElement("div");
  block.className = "tool-block";
  const line = document.createElement("div");
  line.textContent = `⚙ ${toolSummary(name, input)}`;
  block.appendChild(line);
  return block;
}

function appendToolLine(block, name, input) {
  const line = document.createElement("div");
  line.textContent = `⚙ ${toolSummary(name, input)}`;
  block.appendChild(line);
}

function createAgentThreadBlock(input) {
  const thread = document.createElement("div");
  thread.className = "agent-thread";

  const header = document.createElement("div");
  header.className = "agent-thread-header";
  header.textContent = `→ ${input.agent}`;
  thread.appendChild(header);

  const outbound = document.createElement("div");
  outbound.className = "agent-thread-msg outbound";
  outbound.textContent = input.message ?? "";
  thread.appendChild(outbound);

  const inbound = document.createElement("div");
  inbound.className = "agent-thread-msg inbound pending";
  inbound.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  thread.appendChild(inbound);

  thread._inbound = inbound;
  return thread;
}

function fillAgentThreadResponse(thread, result) {
  const el = thread._inbound;
  if (!el) return;
  el.classList.remove("pending");
  if (result?.response) {
    el.innerHTML = renderMarkdown(result.response);
  } else if (result?.error) {
    el.textContent = `⚠ ${result.error}`;
    el.classList.add("error");
  } else {
    el.textContent = JSON.stringify(result);
  }
}

export async function loadHistory(sessionId) {
  try {
    const resp = await fetch(`/api/chat/${_getAgent()}/${sessionId}`);
    if (!resp.ok) return;
    const data = await resp.json();
    for (const msg of data.messages ?? []) {
      const role = msg.role === "assistant" ? "agent" : "user";
      const bubble = addMessage(role, msg.text, msg.raw_index, msg.ts);
      if (msg.reasoning && bubble) {
        const details = document.createElement("details");
        details.className = "reasoning-block";
        details.innerHTML = `<summary>Reasoning</summary><div class="reasoning-content"></div>`;
        details.querySelector(".reasoning-content").textContent = msg.reasoning;
        bubble.parentElement.insertBefore(details, bubble);
      }
    }
    historyIndex = data.total ?? 0;
  } catch (e) {
    console.error("Failed to load history", e);
  }
}

async function sendMessage(getSessionId) {
  let sessionId = getSessionId();
  if (!sessionId) {
    try {
      const resp = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: _getAgent() }),
      });
      const data = await resp.json();
      _onRotate(data.session_id);
      sessionId = data.session_id;
      _onDone();
    } catch {
      addMessage("agent", "⚠ Failed to create session.");
      return;
    }
  }
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = "";
  inputEl.style.height = "auto";
  _pinnedToBottom = true;
  setAgentRunning(true);

  const userMsgIndex = historyIndex;
  addMessage("user", text, userMsgIndex, Math.floor(Date.now() / 1000));
  historyIndex += 1;
  addTypingIndicator();

  // Capture the session this request belongs to; bail if the user switches away mid-stream
  const streamSessionId = sessionId;

  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, message: text, agent: _getAgent(), model: _getModel() || undefined }),
    });
    if (!resp.ok) throw new Error(`Server error: ${resp.status}`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    currentAgentText = "";
    currentReasoningText = "";
    currentReasoningEl = null;
    currentAgentBubble = null;
    currentMsgEl = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // If the user switched away, drain the stream silently so the backend can finish saving
      if (getSessionId() !== streamSessionId) {
        while (true) {
          const { done: d } = await reader.read();
          if (d) break;
        }
        setAgentRunning(false);
        return;
      }

      const lines = buffer.split("\n\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr) continue;
        let event;
        try { event = JSON.parse(jsonStr); } catch { continue; }

        if (event.type === "session_rotating") {
          removeTypingIndicator();
          const el = document.createElement("div");
          el.id = "session-rotating";
          el.className = "session-rotating-indicator";
          el.innerHTML = `<span class="rotating-spinner"></span>Rotating session &amp; updating memory…`;
          messagesEl.appendChild(el);
          scrollToBottom();
        } else if (event.type === "session_rotated") {
          const indicator = document.getElementById("session-rotating");
          if (indicator) indicator.remove();
          sessionId = event.session_id;
          _onRotate(sessionId);
          const el = document.createElement("div");
          el.className = "reflection-msg";
          el.innerHTML = `<span class="reflection-label">New session</span>Started a new session (${event.reason})`;
          messagesEl.appendChild(el);
          scrollToBottom();
        } else if (event.type === "reasoning") {
          removeTypingIndicator();
          if (!currentMsgEl) {
            currentMsgEl = document.createElement("div");
            currentMsgEl.className = "msg agent";
            const header = document.createElement("div");
            header.className = "msg-header";
            const label = document.createElement("div");
            label.className = "msg-label";
            label.textContent = _getAgentTitle();
            header.appendChild(label);
            currentMsgEl.appendChild(header);
            messagesEl.appendChild(currentMsgEl);
          }
          if (!currentReasoningEl) {
            currentReasoningEl = document.createElement("details");
            currentReasoningEl.className = "reasoning-block";
            currentReasoningEl.open = false;
            currentReasoningEl.innerHTML = `<summary>Reasoning…</summary><div class="reasoning-content"></div>`;
            currentMsgEl.appendChild(currentReasoningEl);
          }
          currentReasoningText += event.text;
          currentReasoningEl.querySelector(".reasoning-content").textContent = currentReasoningText;
          scrollToBottom();
        } else if (event.type === "text") {
          removeTypingIndicator();
          currentToolBlock = null;
          if (currentReasoningEl) {
            currentReasoningEl.removeAttribute("open");
            currentReasoningEl.querySelector("summary").textContent = "Reasoning";
            currentReasoningEl = null;
          }
          if (!currentMsgEl) {
            currentMsgEl = document.createElement("div");
            currentMsgEl.className = "msg agent";
            const header = document.createElement("div");
            header.className = "msg-header";
            const label = document.createElement("div");
            label.className = "msg-label";
            label.textContent = _getAgentTitle();
            header.appendChild(label);
            currentMsgEl.appendChild(header);
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
          removeTypingIndicator();
          currentAgentBubble = null;
          currentAgentText = "";
          if (currentReasoningEl) {
            currentReasoningEl.removeAttribute("open");
            currentReasoningEl.querySelector("summary").textContent = "Reasoning";
            currentReasoningEl = null;
          }
          currentReasoningText = "";
          if (!currentMsgEl) {
            currentMsgEl = document.createElement("div");
            currentMsgEl.className = "msg agent";
            const header = document.createElement("div");
            header.className = "msg-header";
            const label = document.createElement("div");
            label.className = "msg-label";
            label.textContent = _getAgentTitle();
            header.appendChild(label);
            currentMsgEl.appendChild(header);
            messagesEl.appendChild(currentMsgEl);
          }
          if (event.name === "message_agent") {
            currentToolBlock = null;
            currentAgentThreadEl = createAgentThreadBlock(event.input);
            currentMsgEl.appendChild(currentAgentThreadEl);
          } else if (!currentToolBlock) {
            currentToolBlock = addToolBlock(event.name, event.input);
            currentMsgEl.appendChild(currentToolBlock);
          } else {
            appendToolLine(currentToolBlock, event.name, event.input);
          }
          scrollToBottom();
        } else if (event.type === "tool_confirm_request") {
          removeTypingIndicator();
          Voice.cancelSpeech();
          const confirm = document.createElement("div");
          confirm.className = "tool-confirm";
          confirm.innerHTML = `
            <span class="tool-confirm-label">Permission required</span>
            <span class="tool-confirm-name">⚙ ${toolSummary(event.name, event.input)}</span>
            <div class="tool-confirm-actions">
              <button class="tool-confirm-btn allow">Allow</button>
              <button class="tool-confirm-btn deny">Deny</button>
            </div>`;
          if (currentMsgEl) currentMsgEl.appendChild(confirm);
          else messagesEl.appendChild(confirm);
          scrollToBottom();

          const respond = async (approved) => {
            confirm.querySelector(".tool-confirm-actions").remove();
            confirm.querySelector(".tool-confirm-label").textContent = approved ? "Allowed" : "Denied";
            confirm.classList.add(approved ? "allowed" : "denied");
            await fetch(`/api/tool-confirm/${event.request_id}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ approved }),
            });
            if (approved) addTypingIndicator();
          };
          confirm.querySelector(".allow").addEventListener("click", () => respond(true));
          confirm.querySelector(".deny").addEventListener("click", () => respond(false));
        } else if (event.type === "tool_result") {
          if (event.name === "message_agent" && currentAgentThreadEl) {
            fillAgentThreadResponse(currentAgentThreadEl, event.result);
            currentAgentThreadEl = null;
            currentMsgEl = null;
            currentToolBlock = null;
            currentReasoningEl = null;
            currentReasoningText = "";
            addTypingIndicator();
            scrollToBottom();
            continue;
          }
          if (event.name === "render_artifact" && event.result?.url) {
            showArtifact(event.result.url, event.result.title);
          }
          if (event.name === "show_image" && event.result?.ok) {
            if (!currentMsgEl) {
              currentMsgEl = document.createElement("div");
              currentMsgEl.className = "msg agent";
              const header = document.createElement("div");
              header.className = "msg-header";
              const label = document.createElement("div");
              label.className = "msg-label";
              label.textContent = _getAgentTitle();
              header.appendChild(label);
              currentMsgEl.appendChild(header);
              messagesEl.appendChild(currentMsgEl);
            }
            const figure = document.createElement("figure");
            figure.className = "inline-image";
            const img = document.createElement("img");
            img.src = event.result.url;
            img.alt = event.result.caption || "";
            img.loading = "lazy";
            figure.appendChild(img);
            if (event.result.caption) {
              const cap = document.createElement("figcaption");
              cap.textContent = event.result.caption;
              figure.appendChild(cap);
            }
            currentMsgEl.appendChild(figure);
            scrollToBottom();
          }
          currentMsgEl = null;
          currentToolBlock = null;
          currentReasoningEl = null;
          currentReasoningText = "";
          addTypingIndicator();
        } else if (event.type === "reflection") {
          const el = document.createElement("div");
          el.className = "reflection-msg";
          el.innerHTML = `<span class="reflection-label">Memory</span>${renderMarkdown(event.text)}`;
          messagesEl.appendChild(el);
          scrollToBottom();
        } else if (event.type === "error") {
          removeTypingIndicator();
          addMessage("agent", `⚠ Error: ${event.text}${event.detail ? "\n\n" + event.detail : ""}`);
        } else if (event.type === "stopped") {
          removeTypingIndicator();
          Voice.cancelSpeech();
          currentMsgEl = null;
          currentAgentBubble = null;
          currentAgentText = "";
          currentReasoningText = "";
          currentReasoningEl = null;
          currentToolBlock = null;
          currentAgentThreadEl = null;
        } else if (event.type === "done") {
          removeTypingIndicator();
          const spokenText = currentAgentText;
          currentMsgEl = null;
          currentAgentBubble = null;
          currentAgentText = "";
          currentReasoningText = "";
          currentReasoningEl = null;
          currentToolBlock = null;
          currentAgentThreadEl = null;
          Voice.onAgentDone(spokenText);
          _onDone();
          fetch(`/api/chat/${_getAgent()}/${sessionId}`)
            .then(r => r.json())
            .then(d => { historyIndex = d.total ?? historyIndex; })
            .catch(() => {});
        }
      }
    }
  } catch (err) {
    removeTypingIndicator();
    addMessage("agent", `Error: ${err.message}`);
  }

  setAgentRunning(false);
  inputEl.focus();
}

let _currentArtifactUrl = "";

export async function showArtifact(url, title) {
  _currentArtifactUrl = url;
  const iframe = document.getElementById("artifact-iframe");
  document.getElementById("artifact-title").textContent = title || "Artifact";
  document.getElementById("app").classList.add("artifact-open");

  const isMarkdown = url.match(/\.md(\?|$)/i) && !url.startsWith("http");
  if (isMarkdown) {
    const resp = await fetch(url);
    const md = await resp.text();
    iframe.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.6; color: #1a1a1a; max-width: 760px; margin: 0 auto; padding: 24px 32px; }
      h1,h2,h3,h4 { margin: 1.2em 0 0.4em; font-weight: 600; }
      h1 { font-size: 1.6em; border-bottom: 1px solid #e5e5e5; padding-bottom: 0.3em; }
      h2 { font-size: 1.3em; }
      code { background: #f5f5f5; padding: 2px 5px; border-radius: 3px; font-size: 0.88em; }
      pre { background: #f5f5f5; padding: 14px; border-radius: 6px; overflow-x: auto; }
      pre code { background: none; padding: 0; }
      blockquote { border-left: 3px solid #d0d0d0; margin: 0; padding-left: 16px; color: #555; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #e0e0e0; padding: 6px 12px; text-align: left; }
      th { background: #f8f8f8; font-weight: 600; }
      a { color: #0066cc; }
      hr { border: none; border-top: 1px solid #e5e5e5; }
      p { margin: 0.6em 0; }
    </style></head><body>${renderMarkdown(md)}</body></html>`;
    return;
  }

  if (iframe.src === url || iframe.src === location.origin + url) {
    iframe.contentWindow?.location.reload();
  } else {
    iframe.srcdoc = "";
    iframe.src = url;
  }
}

export function reset() {
  historyIndex = 0;
  currentAgentBubble = null;
  currentAgentText = "";
  currentReasoningText = "";
  currentReasoningEl = null;
  currentMsgEl = null;
  currentToolBlock = null;
  currentAgentThreadEl = null;
  messagesEl.innerHTML = "";
}

export function init(getSessionId, onRotate, getAgent, onDone, getAgentTitle, getModel) {
  _getSessionId = getSessionId;
  if (onRotate) _onRotate = onRotate;
  if (getAgent) _getAgent = getAgent;
  if (onDone) _onDone = onDone;
  if (getAgentTitle) _getAgentTitle = getAgentTitle;
  if (getModel) _getModel = getModel;
  Voice.init((text) => {
    inputEl.value = text;
    sendMessage(_getSessionId);
  });
  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
  });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(getSessionId);
    }
  });
  sendBtn.addEventListener("click", () => sendMessage(getSessionId));
  const artifactCloseBtn = document.getElementById("artifact-close");
  if (artifactCloseBtn) {
    artifactCloseBtn.addEventListener("click", () => {
      document.getElementById("app").classList.remove("artifact-open");
      document.getElementById("artifact-iframe").src = "";
    });
  }

  const artifactBrowseBtn = document.getElementById("artifact-browse");
  const artifactBrowser = document.getElementById("artifact-browser");
  const artifactBrowserList = document.getElementById("artifact-browser-list");

  if (artifactBrowseBtn) {
    artifactBrowseBtn.addEventListener("click", async () => {
      const isOpen = !artifactBrowser.classList.contains("hidden");
      if (isOpen) {
        artifactBrowser.classList.add("hidden");
        return;
      }
      const agent = _getAgent();
      artifactBrowserList.innerHTML = `<div class="artifact-browser-empty">Loading…</div>`;
      artifactBrowser.classList.remove("hidden");
      try {
        const resp = await fetch(`/api/artifacts/${agent}`);
        const files = await resp.json();
        if (!files.length) {
          artifactBrowserList.innerHTML = `<div class="artifact-browser-empty">No artifacts yet.</div>`;
          return;
        }
        artifactBrowserList.innerHTML = "";
        for (const f of files) {
          const url = `/api/artifacts/${agent}/${f}`;
          const btn = document.createElement("button");
          btn.className = "artifact-file-item" + (url === _currentArtifactUrl ? " active" : "");
          btn.textContent = f;
          btn.title = f;
          btn.addEventListener("click", () => {
            artifactBrowser.classList.add("hidden");
            showArtifact(url, f);
          });
          artifactBrowserList.appendChild(btn);
        }
      } catch {
        artifactBrowserList.innerHTML = `<div class="artifact-browser-empty">Failed to load.</div>`;
      }
    });
  }

  if (stopBtn) {
    stopBtn.addEventListener("click", () => {
      const sessionId = getSessionId();
      if (sessionId) {
        fetch(`/api/chat/${_getAgent()}/${sessionId}/stop`, { method: "POST" });
      }
    });
  }
}
