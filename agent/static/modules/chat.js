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
    case "browse_page_js":       return `browse_js  ${input.url}`;
    case "run_python":           return `run_python  ${(input.code ?? "").split("\n")[0].slice(0, 60)}`;
    case "parse_redfin_listing":     return `parse_redfin  ${input.url}`;
    case "show_image":               return `show_image  ${input.url}`;
    case "property_report":         return `property_report  ${input.address}`;
    case "set_onboarding_status": return `set_onboarding  ${input.file}  →  ${input.status}`;
    case "claude_code":          return `claude_code  ${(input.prompt ?? "").slice(0, 60)}`;
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

    if (data.truncated_sessions > 0 && data.conv_summary) {
      const card = document.createElement("div");
      card.className = "history-summary-card";
      card.innerHTML = `
        <div class="history-summary-header" role="button" aria-expanded="false">
          <span class="history-summary-label">Earlier history (${data.truncated_sessions} session${data.truncated_sessions !== 1 ? "s" : ""})</span>
          <span class="history-summary-toggle">▸</span>
        </div>
        <div class="history-summary-body" hidden>${renderMarkdown(data.conv_summary)}</div>`;
      const header = card.querySelector(".history-summary-header");
      const body = card.querySelector(".history-summary-body");
      const toggle = card.querySelector(".history-summary-toggle");
      header.addEventListener("click", () => {
        const expanded = !body.hidden;
        body.hidden = expanded;
        toggle.textContent = expanded ? "▸" : "▾";
        header.setAttribute("aria-expanded", String(!expanded));
      });
      messagesEl.appendChild(card);
    }

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
  setAgentRunning(true);

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

  setAgentRunning(false);
  inputEl.focus();
}

export function reset(convId, sessionId) {
  historyIndex = 0;
  currentAgentBubble = null;
  currentAgentText = "";
  currentMsgEl = null;
  currentToolBlock = null;
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
  if (stopBtn) {
    stopBtn.addEventListener("click", () => {
      const { convId, sessionId } = getIds();
      if (convId && sessionId) {
        fetch(`/api/chat/${convId}/${sessionId}/stop`, { method: "POST" });
      }
    });
  }
}
