const container = document.getElementById("agent-debug-panel");

const MODE_COLORS = {
  "heartbeat":    "#6b9bd2",
  "self-eval":    "#9b7fd4",
  "post-session": "#5aa87a",
  "message":      "#c8974a",
};

function modeColor(mode) {
  for (const [key, color] of Object.entries(MODE_COLORS)) {
    if (mode.startsWith(key)) return color;
  }
  return "#888";
}

function formatDuration(ms) {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTs(epochMs) {
  return new Date(epochMs).toLocaleString([], {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
}

function renderRun(run) {
  const card = document.createElement("div");
  card.className = "debug-run";

  const color = modeColor(run.mode);
  const header = document.createElement("div");
  header.className = "debug-run-header";
  header.innerHTML = `
    <span class="debug-mode-badge" style="background:${color}">${run.mode}</span>
    <span class="debug-ts">${formatTs(run.started_at)}</span>
    <span class="debug-duration">${formatDuration(run.duration_ms)}</span>
    <span class="debug-preview">${escHtml(run.result || "no output")}</span>
    <span class="debug-toggle">▸</span>
  `;

  const body = document.createElement("div");
  body.className = "debug-run-body hidden";

  // System prompt
  const promptSection = document.createElement("div");
  promptSection.className = "debug-section";
  const promptToggle = document.createElement("div");
  promptToggle.className = "debug-section-toggle";
  promptToggle.textContent = `▸ System prompt (${(run.prompt || "").length.toLocaleString()} chars)`;
  const promptContent = document.createElement("pre");
  promptContent.className = "debug-prompt hidden";
  promptContent.textContent = run.prompt || "(none)";
  promptToggle.addEventListener("click", () => {
    promptContent.classList.toggle("hidden");
    promptToggle.textContent = promptContent.classList.contains("hidden")
      ? `▸ System prompt (${(run.prompt || "").length.toLocaleString()} chars)`
      : `▾ System prompt (${(run.prompt || "").length.toLocaleString()} chars)`;
  });
  promptSection.appendChild(promptToggle);
  promptSection.appendChild(promptContent);

  // Tool calls
  const toolSection = document.createElement("div");
  toolSection.className = "debug-section";
  const calls = run.tool_calls || [];
  if (calls.length > 0) {
    toolSection.innerHTML = `<div class="debug-section-label">Tool calls (${calls.length})</div>`;
    calls.forEach(tc => {
      const row = document.createElement("div");
      row.className = "debug-tool-row";
      row.innerHTML = `
        <span class="debug-tool-name">${escHtml(tc.name)}</span>
        <span class="debug-tool-input">${escHtml(JSON.stringify(tc.input || {}).slice(0, 200))}</span>
        ${tc.result_preview ? `<span class="debug-tool-result">${escHtml(tc.result_preview)}</span>` : ""}
      `;
      toolSection.appendChild(row);
    });
  } else {
    toolSection.innerHTML = `<div class="debug-section-label" style="color:#666">No tool calls</div>`;
  }

  // Full result
  const resultSection = document.createElement("div");
  resultSection.className = "debug-section";
  resultSection.innerHTML = `<div class="debug-section-label">Result</div>`;
  const resultPre = document.createElement("pre");
  resultPre.className = "debug-result";
  resultPre.textContent = run.result || "(no output)";
  resultSection.appendChild(resultPre);

  body.appendChild(promptSection);
  body.appendChild(toolSection);
  body.appendChild(resultSection);
  card.appendChild(header);
  card.appendChild(body);

  header.addEventListener("click", () => {
    body.classList.toggle("hidden");
    const toggle = header.querySelector(".debug-toggle");
    toggle.textContent = body.classList.contains("hidden") ? "▸" : "▾";
  });

  return card;
}

function renderAgent(agent, runs) {
  const section = document.createElement("div");
  section.className = "debug-agent";

  const titleBar = document.createElement("div");
  titleBar.className = "debug-agent-title";
  titleBar.innerHTML = `<span class="debug-agent-name">${escHtml(agent.name)}</span>
    <span class="debug-agent-title-text">${escHtml(agent.title || "")}</span>
    <span class="debug-run-count">${runs.length} run${runs.length !== 1 ? "s" : ""}</span>`;

  const runsDiv = document.createElement("div");
  runsDiv.className = "debug-agent-runs";
  if (runs.length === 0) {
    runsDiv.innerHTML = `<div class="debug-empty">No runs recorded yet.</div>`;
  } else {
    runs.forEach(run => runsDiv.appendChild(renderRun(run)));
  }

  section.appendChild(titleBar);
  section.appendChild(runsDiv);
  return section;
}

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function load() {
  container.innerHTML = `<div class="debug-loading">Loading agent runs…</div>`;
  try {
    const agents = await fetch("/api/agents").then(r => r.json());
    const runResults = await Promise.all(
      agents.map(a => fetch(`/api/agents/${a.name}/runs?limit=20`).then(r => r.json()).then(runs => ({ agent: a, runs })))
    );
    container.innerHTML = "";
    for (const { agent, runs } of runResults) {
      container.appendChild(renderAgent(agent, runs));
    }
    if (agents.length === 0) {
      container.innerHTML = `<div class="debug-empty">No agents registered.</div>`;
    }
  } catch (err) {
    container.innerHTML = `<div class="debug-empty">Failed to load: ${escHtml(err.message)}</div>`;
  }
}
