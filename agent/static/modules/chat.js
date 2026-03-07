import { renderMarkdown } from "./utils.js";
import { setPendingRequest, resolveWithResponse } from "./inspector.js";

const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send-btn");

let currentAgentBubble = null;
let currentAgentText = "";
let currentMsgEl = null;
let historyIndex = 0;
let _getIds = () => ({ convId: null, sessionId: null });
let _onRotate = (_newSessionId) => {};

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function rewindTo(msgEl, fromIndex) {
  const { convId, sessionId } = _getIds();
  await fetch(`/api/chat/${convId}/${sessionId}/truncate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ index: fromIndex }),
  });
  // Remove this element and everything after it in the DOM
  while (messagesEl.lastChild && messagesEl.lastChild !== msgEl) {
    messagesEl.removeChild(messagesEl.lastChild);
  }
  messagesEl.removeChild(msgEl);
  historyIndex = fromIndex;
}

export function addMessage(role, content, msgIndex) {
  const msg = document.createElement("div");
  msg.className = `msg ${role}`;

  const header = document.createElement("div");
  header.className = "msg-header";

  const label = document.createElement("div");
  label.className = "msg-label";
  label.textContent = role === "user" ? "You" : "Agent";
  header.appendChild(label);

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

function addSessionDivider(sessionIndex, isCurrent) {
  const el = document.createElement("div");
  el.className = "session-divider";
  el.textContent = isCurrent ? `Session ${sessionIndex + 1} (current)` : `Session ${sessionIndex + 1}`;
  messagesEl.appendChild(el);
}

export async function loadHistory(convId, sessionId) {
  try {
    const resp = await fetch(`/api/chat/${convId}`);
    if (!resp.ok) return;
    const data = await resp.json();
    const sessions = data.sessions ?? [];
    const nonEmpty = sessions.filter(s => s.messages.length > 0);
    nonEmpty.forEach((session, idx) => {
      if (nonEmpty.length > 1) addSessionDivider(idx, session.is_current);
      for (const msg of session.messages) {
        const role = msg.role === "assistant" ? "agent" : "user";
        const rawIndex = session.is_current ? msg.raw_index : undefined;
        addMessage(role, msg.text, rawIndex);
      }
      if (session.is_current) historyIndex = session.total ?? 0;
    });
  } catch (e) {
    console.error("Failed to load history", e);
  }
}

async function sendMessage(getIds, onProjectRefresh) {
  const { convId } = getIds();
  let { sessionId } = getIds();
  if (!convId || !sessionId) {
    addMessage("agent", "⚠ No active conversation. Click a project to start one.");
    return;
  }
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = "";
  inputEl.style.height = "auto";
  sendBtn.disabled = true;

  const userMsgIndex = historyIndex;
  addMessage("user", text, userMsgIndex);
  historyIndex += 1;
  addTypingIndicator();

  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conv_id: convId, session_id: sessionId, message: text }),
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
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;
        let event;
        try { event = JSON.parse(jsonStr); } catch { continue; }

        if (event.type === "session_rotated") {
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
          currentMsgEl.appendChild(addToolBlock(event.name, event.input));
          scrollToBottom();
        } else if (event.type === "tool_result") {
          if (["create_project", "update_project", "list_projects"].includes(event.name)) {
            onProjectRefresh();
          }
        } else if (event.type === "reflection") {
          const el = document.createElement("div");
          el.className = "reflection-msg";
          el.innerHTML = `<span class="reflection-label">Memory</span>${renderMarkdown(event.text)}`;
          messagesEl.appendChild(el);
          scrollToBottom();
        } else if (event.type === "error") {
          removeTypingIndicator();
          addMessage("agent", `⚠ Error: ${event.text}${event.detail ? "\n\n" + event.detail : ""}`);
        } else if (event.type === "done") {
          currentMsgEl = null;
          currentAgentBubble = null;
          currentAgentText = "";
          fetch(`/api/chat/${convId}/${sessionId}`)
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

  sendBtn.disabled = false;
  inputEl.focus();
}

export function reset(convId, sessionId) {
  historyIndex = 0;
  currentAgentBubble = null;
  currentAgentText = "";
  currentMsgEl = null;
  messagesEl.innerHTML = "";
}

export function init(getIds, onProjectRefresh, onRotate) {
  _getIds = getIds;
  if (onRotate) _onRotate = onRotate;
  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
  });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(getIds, onProjectRefresh);
    }
  });
  sendBtn.addEventListener("click", () => sendMessage(getIds, onProjectRefresh));
}
