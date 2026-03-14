import { renderMarkdown } from "./utils.js";
import { setPendingRequest, resolveWithResponse } from "./inspector.js";

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
let currentMsgEl = null;
let currentToolBlock = null;
let historyIndex = 0;
let _getSessionId = () => null;
let _onRotate = (_newSessionId) => {};

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function rewindTo(msgEl, fromIndex) {
  const sessionId = _getSessionId();
  await fetch(`/api/chat/${sessionId}/truncate`, {
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
  label.textContent = role === "user" ? "You" : "Agent";
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

export function removeTypingIndicator() {
  const el = document.getElementById("typing");
  if (el) el.remove();
}

function toolSummary(name, input) {
  switch (name) {
    case "web_search":    return `web_search  "${input.query}"`;
    case "browse_page":   return `browse  ${input.url}`;
    case "create_project":
    case "update_project":
    case "read_project":  return `${name}  ${input.name}`;
    case "add_project_file":
    case "read_project_file":
    case "update_project_file":
    case "delete_project_file": return `${name}  ${input.name ?? input.project}  /  ${input.filename}`;
    case "update_knowledge": return `update_knowledge  ${input.file}`;
    case "read_knowledge":   return `read_knowledge  ${input.file}`;
    case "write_file":
    case "read_file":
    case "update_file":   return `${name}  ${input.path ?? input.name ?? ""}`;
    case "list_projects": return "list_projects";
    case "list_dir":      return `list_dir  ${input.path ?? ""}`;
    case "parse_redfin_search":  return `parse_redfin_search  ${input.url}`;
    case "parse_redfin_listing": return `parse_redfin  ${input.url}`;
    case "show_image":           return `show_image  ${input.url}`;
    case "property_report":      return `property_report  ${input.address}`;
    case "set_onboarding_status": return `set_onboarding  ${input.file}  →  ${input.status}`;
    default:
      if (name.startsWith("chrome_")) return `${name}  ${input.url ?? input.selector ?? input.script?.slice(0, 40) ?? ""}`.trimEnd();
      return name;
  }
}

function addToolBlock(name, input) {
  const block = document.createElement("div");
  block.className = "tool-block";
  block.textContent = `⚙ ${toolSummary(name, input)}`;
  return block;
}

export async function loadHistory(sessionId) {
  try {
    const resp = await fetch(`/api/chat/${sessionId}`);
    if (!resp.ok) return;
    const data = await resp.json();
    for (const msg of data.messages ?? []) {
      const role = msg.role === "assistant" ? "agent" : "user";
      addMessage(role, msg.text, msg.raw_index, msg.ts);
    }
    historyIndex = data.total ?? 0;
  } catch (e) {
    console.error("Failed to load history", e);
  }
}

async function sendMessage(getSessionId, onProjectRefresh) {
  let sessionId = getSessionId();
  if (!sessionId) {
    addMessage("agent", "⚠ No active session.");
    return;
  }
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = "";
  inputEl.style.height = "auto";
  setAgentRunning(true);

  const userMsgIndex = historyIndex;
  addMessage("user", text, userMsgIndex, Math.floor(Date.now() / 1000));
  historyIndex += 1;
  addTypingIndicator();

  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, message: text }),
    });
    if (!resp.ok) throw new Error(`Server error: ${resp.status}`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

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
        } else if (event.type === "request_json") {
          setPendingRequest(event.payload);
        } else if (event.type === "response_json") {
          resolveWithResponse(event.payload);
        } else if (event.type === "text") {
          removeTypingIndicator();
          currentToolBlock = null;
          if (!currentMsgEl) {
            currentMsgEl = document.createElement("div");
            currentMsgEl.className = "msg agent";
            const header = document.createElement("div");
            header.className = "msg-header";
            const label = document.createElement("div");
            label.className = "msg-label";
            label.textContent = "Agent";
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
          if (!currentMsgEl) {
            currentMsgEl = document.createElement("div");
            currentMsgEl.className = "msg agent";
            const header = document.createElement("div");
            header.className = "msg-header";
            const label = document.createElement("div");
            label.className = "msg-label";
            label.textContent = "Agent";
            header.appendChild(label);
            currentMsgEl.appendChild(header);
            messagesEl.appendChild(currentMsgEl);
          }
          if (!currentToolBlock) {
            currentToolBlock = addToolBlock(event.name, event.input);
            currentMsgEl.appendChild(currentToolBlock);
          } else {
            currentToolBlock.textContent = `⚙ ${toolSummary(event.name, event.input)}`;
          }
          scrollToBottom();
        } else if (event.type === "tool_confirm_request") {
          removeTypingIndicator();
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
          if (["create_project", "update_project", "list_projects"].includes(event.name)) {
            onProjectRefresh();
          }
          if (event.name === "show_image" && event.result?.ok) {
            if (!currentMsgEl) {
              currentMsgEl = document.createElement("div");
              currentMsgEl.className = "msg agent";
              const header = document.createElement("div");
              header.className = "msg-header";
              const label = document.createElement("div");
              label.className = "msg-label";
              label.textContent = "Agent";
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
          currentMsgEl = null;
          currentAgentBubble = null;
          currentAgentText = "";
          currentToolBlock = null;
        } else if (event.type === "done") {
          currentMsgEl = null;
          currentAgentBubble = null;
          currentAgentText = "";
          currentToolBlock = null;
          fetch(`/api/chat/${sessionId}`)
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

export function reset(sessionId) {
  historyIndex = 0;
  currentAgentBubble = null;
  currentAgentText = "";
  currentMsgEl = null;
  currentToolBlock = null;
  messagesEl.innerHTML = "";
}

export function init(getSessionId, onProjectRefresh, onRotate) {
  _getSessionId = getSessionId;
  if (onRotate) _onRotate = onRotate;
  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
  });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(getSessionId, onProjectRefresh);
    }
  });
  sendBtn.addEventListener("click", () => sendMessage(getSessionId, onProjectRefresh));
  if (stopBtn) {
    stopBtn.addEventListener("click", () => {
      const sessionId = getSessionId();
      if (sessionId) {
        fetch(`/api/chat/${sessionId}/stop`, { method: "POST" });
      }
    });
  }
}
