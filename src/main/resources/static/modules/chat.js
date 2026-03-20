import { renderMarkdown } from "./utils.js";
import { setPendingRequest, resolveWithResponse } from "./inspector.js";
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
let currentMsgEl = null;
let currentToolBlock = null;
let historyIndex = 0;
let _getSessionId = () => null;
let _onRotate = (_newSessionId) => {};
let _onDone = () => {};
let _getAgent = () => "main";
let _getAgentTitle = () => "Agent";

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
    case "browse_page":           return `browse  ${input.url}`;
    case "get_current_datetime":  return `get_current_datetime`;
    case "set_reminder":          return `set_reminder  ${input.time}  "${input.message}"`;
    case "list_reminders":        return `list_reminders`;
    case "delete_reminder":       return `delete_reminder  ${input.id}`;
    case "list_sessions":         return `list_sessions`;
    case "read_session_summary":  return `read_session_summary  ${input.session_id}`;
    case "read_session_transcript": return `read_session_transcript  ${input.session_id}`;
    case "message_agent": {
      const msg = input.message ?? "";
      const preview = msg.length > 50 ? msg.slice(0, 50) + "…" : msg;
      return `→ ${input.agent}  "${preview}"`;
    }
    case "read_agent_workspace":  return `${input.agent}  $ ${input.command}`;
    case "read_agent_definition": return `read_agent_definition  ${input.agent}`;
    case "list_agents":           return `list_agents`;
    case "list_tools":            return `list_tools`;
    case "create_agent":          return `create_agent  ${input.name}`;
    case "update_agent":          return `update_agent  ${input.name}`;
    case "parse_redfin_search":   return `redfin_search  ${input.url}`;
    case "parse_redfin_listing":  return `redfin  ${input.url}`;
    case "show_image":            return `show_image  ${input.url}`;
    case "property_report":       return `property_report  ${input.address}`;
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

async function sendMessage(getSessionId) {
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

  // Capture the session this request belongs to; bail if the user switches away mid-stream
  const streamSessionId = sessionId;

  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, message: text, agent: _getAgent() }),
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
      // If the user switched to a different session, discard remaining stream
      if (getSessionId() !== streamSessionId) {
        reader.cancel();
        setAgentRunning(false);
        return;
      }
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
          if (!currentToolBlock) {
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
          currentToolBlock = null;
        } else if (event.type === "done") {
          removeTypingIndicator();
          const spokenText = currentAgentText;
          currentMsgEl = null;
          currentAgentBubble = null;
          currentAgentText = "";
          currentToolBlock = null;
          Voice.onAgentDone(spokenText);
          _onDone();
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

export function init(getSessionId, onRotate, getAgent, onDone, getAgentTitle) {
  _getSessionId = getSessionId;
  if (onRotate) _onRotate = onRotate;
  if (getAgent) _getAgent = getAgent;
  if (onDone) _onDone = onDone;
  if (getAgentTitle) _getAgentTitle = getAgentTitle;
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
  if (stopBtn) {
    stopBtn.addEventListener("click", () => {
      const sessionId = getSessionId();
      if (sessionId) {
        fetch(`/api/chat/${sessionId}/stop`, { method: "POST" });
      }
    });
  }
}
