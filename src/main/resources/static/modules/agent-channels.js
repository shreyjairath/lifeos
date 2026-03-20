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

function renderExchange(ex) {
  const el = document.createElement("div");
  el.className = "channel-exchange";

  const meta = document.createElement("div");
  meta.className = "channel-exchange-meta";
  meta.textContent = `${ex.timestamp}`;

  const outbound = document.createElement("div");
  outbound.className = "channel-msg outbound";
  const outLabel = document.createElement("span");
  outLabel.className = "channel-msg-label";
  outLabel.textContent = ex.sender;
  const outBubble = document.createElement("div");
  outBubble.className = "channel-msg-bubble";
  outBubble.textContent = ex.message;
  outbound.appendChild(outLabel);
  outbound.appendChild(outBubble);

  el.appendChild(meta);
  el.appendChild(outbound);

  if (ex.reply) {
    const inbound = document.createElement("div");
    inbound.className = "channel-msg inbound";
    const inLabel = document.createElement("span");
    inLabel.className = "channel-msg-label";
    inLabel.textContent = ex.recipient;
    const inBubble = document.createElement("div");
    inBubble.className = "channel-msg-bubble";
    inBubble.textContent = ex.reply;
    inbound.appendChild(inLabel);
    inbound.appendChild(inBubble);
    el.appendChild(inbound);
  }

  return el;
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
    // Show newest first — reverse the parsed order
    for (const ex of [...exchanges].reverse()) {
      body.appendChild(renderExchange(ex));
    }
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
