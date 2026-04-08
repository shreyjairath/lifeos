const container = document.getElementById("agent-channels-panel");

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Parse the channel markdown into an array of exchange objects.
 * Each entry in the file is separated by \n\n---\n\n
 * Format:
 *   ## 2026-03-19 14:30 PDT | sender → recipient
 *   {message body}
 *
 *   **recipient replied:**
 *   {reply body}
 */
function parseExchanges(markdown) {
  const blocks = markdown.split(/\n\n---\n\n|\n---\n\n/);
  const exchanges = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // Header line: ## YYYY-MM-DD HH:mm TZ | sender → recipient
    const headerMatch = trimmed.match(/^##\s+(.+?)\s+\|\s+(\S+)\s+→\s+(\S+)/m);
    if (!headerMatch) continue;

    const timestamp = headerMatch[1].trim();
    const sender    = headerMatch[2].trim();
    const recipient = headerMatch[3].trim();

    // Split off the header line
    const body = trimmed.slice(trimmed.indexOf('\n') + 1).trim();

    // Split on the "**recipient replied:**" line
    const replyMatch = body.match(/\*\*(\S+)\s+replied:\*\*\n?([\s\S]*)/);
    let message = body;
    let reply   = "";

    if (replyMatch) {
      message = body.slice(0, body.indexOf(replyMatch[0])).trim();
      reply   = replyMatch[2].trim();
    }

    exchanges.push({ timestamp, sender, recipient, message, reply });
  }

  return exchanges;
}

/** Returns a single chat-row element for one message in the thread. */
function renderMsg(agentName, text, ts, side) {
  const row = document.createElement("div");
  row.className = `channel-msg ${side}`;

  const meta = document.createElement("div");
  meta.className = "channel-msg-meta";
  const nameEl = document.createElement("span");
  nameEl.className = "channel-msg-label";
  nameEl.textContent = agentName;
  meta.appendChild(nameEl);
  if (ts) {
    const tsEl = document.createElement("span");
    tsEl.className = "channel-msg-ts";
    tsEl.textContent = ts;
    meta.appendChild(tsEl);
  }

  const bubble = document.createElement("div");
  bubble.className = "channel-msg-bubble";
  bubble.textContent = text;

  row.appendChild(meta);
  row.appendChild(bubble);
  return row;
}

async function loadChannel(pair) {
  const body = container.querySelector(".channel-body");
  if (!body) return;
  body.innerHTML = `<div class="channel-loading">Loading…</div>`;

  try {
    const data = await fetch(`/api/agents/channels/${encodeURIComponent(pair)}`).then(r => r.json());
    const exchanges = parseExchanges(data.content || "");
    body.innerHTML = "";
    if (exchanges.length === 0) {
      body.innerHTML = `<div class="channel-empty">No exchanges yet.</div>`;
      return;
    }
    // Render as a flat thread, oldest first
    for (const ex of exchanges) {
      const senderSide    = ex.sender    === "cos" ? "outbound" : "inbound";
      const recipientSide = ex.recipient === "cos" ? "outbound" : "inbound";
      body.appendChild(renderMsg(ex.sender, ex.message, ex.timestamp, senderSide));
      if (ex.reply) {
        body.appendChild(renderMsg(ex.recipient, ex.reply, null, recipientSide));
      }
    }
    // Scroll to bottom so newest messages are visible
    body.scrollTop = body.scrollHeight;
  } catch (err) {
    body.innerHTML = `<div class="channel-empty">Failed to load: ${escHtml(err.message)}</div>`;
  }
}

export async function load() {
  container.innerHTML = `<div class="channel-loading">Loading channels…</div>`;
  try {
    const channels = await fetch("/api/agents/channels").then(r => r.json());
    if (channels.length === 0) {
      container.innerHTML = `<div class="channel-empty">No inter-agent channels yet.</div>`;
      return;
    }

    container.innerHTML = "";

    // Selector bar
    const selector = document.createElement("div");
    selector.className = "channel-selector";

    // Body area
    const body = document.createElement("div");
    body.className = "channel-body";
    container.appendChild(selector);
    container.appendChild(body);

    let activePair = null;

    for (const ch of channels) {
      const btn = document.createElement("button");
      btn.className = "channel-selector-btn";
      btn.dataset.pair = ch.pair;
      // Format "cos-therapist" → "cos ↔ therapist"
      btn.textContent = ch.pair.replace("-", " ↔ ");
      btn.addEventListener("click", () => {
        selector.querySelectorAll(".channel-selector-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        activePair = ch.pair;
        loadChannel(ch.pair);
      });
      selector.appendChild(btn);
    }

    // Auto-select first channel
    const first = selector.querySelector(".channel-selector-btn");
    if (first) first.click();

  } catch (err) {
    container.innerHTML = `<div class="channel-empty">Failed to load: ${escHtml(err.message)}</div>`;
  }
}
