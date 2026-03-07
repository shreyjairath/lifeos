import { renderMarkdown } from "./utils.js";

const ccMessagesEl = document.getElementById("cc-messages");
const ccInputEl = document.getElementById("cc-input");
const ccSendBtn = document.getElementById("cc-send");

let CC_SESSION_ID = localStorage.getItem("lifeos-cc-session-id") || null;

function scrollToBottom() {
  ccMessagesEl.scrollTop = ccMessagesEl.scrollHeight;
}

function addMessage(role, content) {
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
  scrollToBottom();
  return bubble;
}

function removeTyping() {
  const t = document.getElementById("cc-typing");
  if (t) t.remove();
}

function addTypingIndicator() {
  const el = document.createElement("div");
  el.className = "cc-msg cc";
  el.id = "cc-typing";
  const label = document.createElement("div");
  label.className = "cc-label";
  label.textContent = "Claude Code";
  const bubble = document.createElement("div");
  bubble.className = "cc-bubble";
  bubble.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  el.appendChild(label);
  el.appendChild(bubble);
  ccMessagesEl.appendChild(el);
  scrollToBottom();
}

async function sendMessage() {
  const text = ccInputEl.value.trim();
  if (!text) return;
  ccInputEl.value = "";
  ccInputEl.style.height = "auto";
  ccSendBtn.disabled = true;

  addMessage("user", text);
  addTypingIndicator();

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

        if (event.type === "cc_block") {
          if (!ccMsgEl) {
            removeTyping();
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
          if (event.block.type === "text") {
            ccText += event.block.text || "";
            ccBubble.innerHTML = renderMarkdown(ccText);
          } else {
            const meta = document.createElement("div");
            meta.className = "cc-block-meta";
            meta.textContent = JSON.stringify(event.block);
            ccBubble.appendChild(meta);
          }
          scrollToBottom();
        } else if (event.type === "session_id") {
          CC_SESSION_ID = event.session_id;
          localStorage.setItem("lifeos-cc-session-id", CC_SESSION_ID);
        } else if (event.type === "error") {
          removeTyping();
          addMessage("cc", `⚠ ${event.text}`);
        }
      }
    }
    removeTyping();
  } catch (err) {
    removeTyping();
    addMessage("cc", `⚠ Error: ${err.message}`);
  }

  ccSendBtn.disabled = false;
  ccInputEl.focus();
}

export async function loadHistory() {
  if (!CC_SESSION_ID) return;
  try {
    const resp = await fetch(`/api/cc/history?session_id=${CC_SESSION_ID}`);
    if (!resp.ok) return;
    const data = await resp.json();
    for (const msg of data.messages) {
      addMessage(msg.role, msg.text);
    }
  } catch (e) {
    console.error("Failed to load CC history", e);
  }
}

export function init() {
  ccSendBtn.addEventListener("click", sendMessage);
  ccInputEl.addEventListener("input", () => {
    ccInputEl.style.height = "auto";
    ccInputEl.style.height = Math.min(ccInputEl.scrollHeight, 120) + "px";
  });
  ccInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
}
