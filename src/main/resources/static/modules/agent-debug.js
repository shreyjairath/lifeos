const container = document.getElementById("agent-debug-panel");

const MODE_COLORS = {
  "heartbeat":           "#6b9bd2",
  "self-eval":           "#9b7fd4",
  "post-session":        "#5aa87a",
  "inter-agent-message": "#c8974a",
  "chat":                "#d4a857",
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

function relativeTime(epochMs) {
  const diffMs = Date.now() - epochMs;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function absoluteTime(epochMs) {
  return new Date(epochMs).toLocaleString([], {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
}

function tsSpan(epochMs) {
  const el = document.createElement("span");
  el.className = "debug-ts";
  el.textContent = relativeTime(epochMs);
  el.title = absoluteTime(epochMs);
  return el;
}

function renderToolCall(tc) {
  const row = document.createElement("div");
  row.className = "debug-tool-row";

  const nameEl = document.createElement("span");
  nameEl.className = "debug-tool-name";
  nameEl.textContent = tc.name;

  let inputJson = "";
  try { inputJson = JSON.stringify(tc.input || {}, null, 2); }
  catch { inputJson = String(tc.input || ""); }

  const inputToggle = document.createElement("span");
  inputToggle.className = "debug-tool-input-toggle";
  inputToggle.textContent = "▸ input";

  const inputPre = document.createElement("pre");
  inputPre.className = "debug-tool-input-pre hidden";
  inputPre.textContent = inputJson;

  inputToggle.addEventListener("click", e => {
    e.stopPropagation();
    inputPre.classList.toggle("hidden");
    inputToggle.textContent = inputPre.classList.contains("hidden") ? "▸ input" : "▾ input";
  });

  row.appendChild(nameEl);
  row.appendChild(inputToggle);
  row.appendChild(inputPre);

  if (tc.result_preview) {
    const resultToggle = document.createElement("span");
    resultToggle.className = "debug-tool-result-toggle";
    resultToggle.textContent = "▸ result";

    const resultPre = document.createElement("pre");
    resultPre.className = "debug-tool-result-pre hidden";
    resultPre.textContent = tc.result_preview;

    resultToggle.addEventListener("click", e => {
      e.stopPropagation();
      resultPre.classList.toggle("hidden");
      resultToggle.textContent = resultPre.classList.contains("hidden") ? "▸ result" : "▾ result";
    });

    row.appendChild(resultToggle);
    row.appendChild(resultPre);
  }

  return row;
}

function renderRun(run) {
  const card = document.createElement("div");
  card.className = "debug-run";

  const color = modeColor(run.mode);
  const header = document.createElement("div");
  header.className = "debug-run-header";

  const badge = document.createElement("span");
  badge.className = "debug-mode-badge";
  badge.style.background = color;
  badge.textContent = run.mode;

  const preview = document.createElement("span");
  preview.className = "debug-preview";
  preview.textContent = run.result || "no output";

  const duration = document.createElement("span");
  duration.className = "debug-duration";
  duration.textContent = formatDuration(run.duration_ms);

  const toggle = document.createElement("span");
  toggle.className = "debug-toggle";
  toggle.textContent = "▸";

  header.appendChild(badge);
  header.appendChild(tsSpan(run.started_at));
  header.appendChild(duration);
  header.appendChild(preview);
  header.appendChild(toggle);

  const body = document.createElement("div");
  body.className = "debug-run-body hidden";

  // System prompt
  const promptSection = document.createElement("div");
  promptSection.className = "debug-section";
  const promptToggle = document.createElement("div");
  promptToggle.className = "debug-section-toggle";
  const promptLen = (run.prompt || "").length.toLocaleString();
  promptToggle.textContent = `▸ System prompt (${promptLen} chars)`;
  const promptContent = document.createElement("pre");
  promptContent.className = "debug-prompt hidden";
  promptContent.textContent = run.prompt || "(none)";
  promptToggle.addEventListener("click", () => {
    promptContent.classList.toggle("hidden");
    promptToggle.textContent = promptContent.classList.contains("hidden")
      ? `▸ System prompt (${promptLen} chars)`
      : `▾ System prompt (${promptLen} chars)`;
  });
  promptSection.appendChild(promptToggle);
  promptSection.appendChild(promptContent);

  // Tool calls
  const toolSection = document.createElement("div");
  toolSection.className = "debug-section";
  const calls = run.tool_calls || [];
  if (calls.length > 0) {
    const label = document.createElement("div");
    label.className = "debug-section-label";
    label.textContent = `Tool calls (${calls.length})`;
    toolSection.appendChild(label);
    calls.forEach(tc => toolSection.appendChild(renderToolCall(tc)));
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
    toggle.textContent = body.classList.contains("hidden") ? "▸" : "▾";
  });

  return card;
}

const ALL_MODES = ["chat", "post-session", "heartbeat", "self-eval", "inter-agent-message"];

function renderAgent(agent, initialRuns) {
  let runs = initialRuns;
  let activeFilter = "all";
  let limit = 20;

  const section = document.createElement("div");
  section.className = "debug-agent";

  // Title bar + trigger buttons
  const titleBar = document.createElement("div");
  titleBar.className = "debug-agent-title";
  titleBar.innerHTML = `<span class="debug-agent-name">${escHtml(agent.name)}</span>
    <span class="debug-agent-title-text">${escHtml(agent.title || "")}</span>`;

  const btnsDiv = document.createElement("div");
  btnsDiv.className = "debug-trigger-btns";

  for (const [label, eventType] of [["Heartbeat", "heartbeat_trigger"], ["Self-Eval", "self_eval_trigger"]]) {
    const btn = document.createElement("button");
    btn.className = "debug-trigger-btn";
    btn.textContent = label;
    btn.addEventListener("click", async e => {
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = "…";
      try {
        await fetch(`/api/agents/trigger/${eventType}`, { method: "POST" });
        btn.textContent = "✓";
        setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 2000);
      } catch {
        btn.textContent = "✗";
        setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 2000);
      }
    });
    btnsDiv.appendChild(btn);
  }
  titleBar.appendChild(btnsDiv);

  // Mode filter bar
  const filterBar = document.createElement("div");
  filterBar.className = "debug-filter-bar";

  const runCount = document.createElement("span");
  runCount.className = "debug-run-count";

  const runsDiv = document.createElement("div");
  runsDiv.className = "debug-agent-runs";

  function render() {
    const filtered = activeFilter === "all" ? runs : runs.filter(r => r.mode === activeFilter);
    runCount.textContent = `${filtered.length} run${filtered.length !== 1 ? "s" : ""}`;
    runsDiv.innerHTML = "";
    if (filtered.length === 0) {
      runsDiv.innerHTML = `<div class="debug-empty">No ${activeFilter === "all" ? "" : activeFilter + " "}runs recorded.</div>`;
    } else {
      filtered.forEach(run => runsDiv.appendChild(renderRun(run)));
    }
  }

  for (const mode of ["all", ...ALL_MODES]) {
    const btn = document.createElement("button");
    btn.className = "debug-filter-btn" + (mode === "all" ? " active" : "");
    btn.textContent = mode;
    btn.dataset.mode = mode;
    btn.addEventListener("click", () => {
      filterBar.querySelectorAll(".debug-filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      activeFilter = mode;
      render();
    });
    filterBar.appendChild(btn);
  }
  filterBar.appendChild(runCount);

  // Load more button
  const loadMore = document.createElement("button");
  loadMore.className = "debug-load-more";
  loadMore.textContent = "Load more";
  loadMore.addEventListener("click", async () => {
    limit += 20;
    loadMore.disabled = true;
    loadMore.textContent = "Loading…";
    try {
      runs = await fetch(`/api/agents/${agent.name}/runs?limit=${limit}`).then(r => r.json());
      render();
    } catch (err) {
      // ignore
    }
    loadMore.textContent = "Load more";
    loadMore.disabled = false;
  });

  render();

  section.appendChild(titleBar);
  section.appendChild(filterBar);
  section.appendChild(runsDiv);
  section.appendChild(loadMore);
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
