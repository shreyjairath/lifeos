const container = document.getElementById("agent-debug-panel");

// ── Pricing ───────────────────────────────────────────────────────────────────

const PRICING = {
  "claude-sonnet-4-6":        { input: 3.00,  output: 15.00 },
  "claude-opus-4-6":          { input: 15.00, output: 75.00 },
  "claude-haiku-4-5-20251001": { input: 0.80,  output: 4.00 },
  "claude-haiku-4-5":         { input: 0.80,  output: 4.00 },
};

function calcCost(run) {
  if (!run.input_tokens && !run.output_tokens) return null;
  const p = PRICING[run.model] ?? PRICING["claude-sonnet-4-6"];
  return (run.input_tokens / 1_000_000) * p.input
       + (run.output_tokens / 1_000_000) * p.output;
}

function fmtTokens(n) {
  if (!n) return "0";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtCost(dollars) {
  if (dollars === null) return "";
  if (dollars < 0.0001) return "<$0.0001";
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`;
  return `$${dollars.toFixed(3)}`;
}

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

function makeTogglePre(labelOpen, labelClose, content) {
  const toggle = document.createElement("span");
  toggle.className = "debug-tool-input-toggle";
  toggle.textContent = labelOpen;
  const pre = document.createElement("pre");
  pre.className = "debug-tool-input-pre hidden";
  pre.textContent = content;
  toggle.addEventListener("click", e => {
    e.stopPropagation();
    pre.classList.toggle("hidden");
    toggle.textContent = pre.classList.contains("hidden") ? labelOpen : labelClose;
  });
  return [toggle, pre];
}

function renderTurns(turns) {
  const wrap = document.createElement("div");
  wrap.className = "debug-turns";
  for (const turn of turns) {
    const turnEl = document.createElement("div");
    const role = turn.role;
    turnEl.className = `debug-turn debug-turn-${role}`;
    const label = document.createElement("span");
    label.className = "debug-turn-label";
    label.textContent = role === "assistant" ? "assistant" : role === "tool" ? "tool result" : "user";
    turnEl.appendChild(label);

    // Reasoning block
    if (typeof turn.reasoning === "string" && turn.reasoning) {
      const details = document.createElement("details");
      details.className = "debug-reasoning-block";
      const summary = document.createElement("summary");
      summary.textContent = "Reasoning";
      const pre = document.createElement("pre");
      pre.className = "debug-reasoning-pre";
      pre.textContent = turn.reasoning;
      details.appendChild(summary);
      details.appendChild(pre);
      turnEl.appendChild(details);
    }

    // OpenAI format: assistant text content (string) — skip for tool results (handled below)
    if (typeof turn.content === "string" && turn.content && role !== "tool") {
      const p = document.createElement("div");
      p.className = "debug-turn-text";
      p.textContent = turn.content;
      turnEl.appendChild(p);
    }

    // OpenAI format: assistant tool_calls array
    if (Array.isArray(turn.tool_calls)) {
      for (const tc of turn.tool_calls) {
        const row = document.createElement("div");
        row.className = "debug-tool-row";
        const name = document.createElement("span");
        name.className = "debug-tool-name";
        name.textContent = tc.function?.name ?? tc.id;
        row.appendChild(name);
        const args = tc.function?.arguments ?? "";
        let argsJson = args;
        try { argsJson = JSON.stringify(JSON.parse(args), null, 2); } catch { /* keep raw */ }
        const [t, p] = makeTogglePre("▸ input", "▾ input", argsJson);
        row.appendChild(t); row.appendChild(p);
        turnEl.appendChild(row);
      }
    }

    // OpenAI format: role=tool message (string content)
    if (role === "tool" && typeof turn.content === "string") {
      const row = document.createElement("div");
      row.className = "debug-tool-row";
      const [t, p] = makeTogglePre("▸ result", "▾ result", turn.content);
      row.appendChild(t); row.appendChild(p);
      turnEl.appendChild(row);
    }

    wrap.appendChild(turnEl);
  }
  return wrap;
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

  const cost = calcCost(run);
  if (cost !== null) {
    const tokEl = document.createElement("span");
    tokEl.className = "debug-tokens";
    tokEl.textContent = `${fmtTokens(run.input_tokens)}↑ ${fmtTokens(run.output_tokens)}↓`;
    tokEl.title = `${run.input_tokens?.toLocaleString()} input / ${run.output_tokens?.toLocaleString()} output`;
    const costEl = document.createElement("span");
    costEl.className = "debug-cost";
    costEl.textContent = fmtCost(cost);
    header.appendChild(tokEl);
    header.appendChild(costEl);
  }

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

  // Turns / tool calls
  const toolSection = document.createElement("div");
  toolSection.className = "debug-section";
  if (run.turns && run.turns.length > 0) {
    const label = document.createElement("div");
    label.className = "debug-section-label";
    label.textContent = `Transcript (${run.turns.length} turns)`;
    toolSection.appendChild(label);
    toolSection.appendChild(renderTurns(run.turns));
  } else {
    toolSection.innerHTML = `<div class="debug-section-label" style="color:#666">No transcript</div>`;
  }

  body.appendChild(promptSection);

  // Tools
  if (run.tool_names && run.tool_names.length > 0) {
    const toolNamesSection = document.createElement("div");
    toolNamesSection.className = "debug-section";
    const toolNamesToggle = document.createElement("div");
    toolNamesToggle.className = "debug-section-toggle";
    toolNamesToggle.textContent = `▸ Tools (${run.tool_names.length})`;
    const toolNamesList = document.createElement("div");
    toolNamesList.className = "debug-tool-names hidden";
    toolNamesList.textContent = run.tool_names.join(", ");
    toolNamesToggle.addEventListener("click", () => {
      toolNamesList.classList.toggle("hidden");
      toolNamesToggle.textContent = toolNamesList.classList.contains("hidden")
        ? `▸ Tools (${run.tool_names.length})`
        : `▾ Tools (${run.tool_names.length})`;
    });
    toolNamesSection.appendChild(toolNamesToggle);
    toolNamesSection.appendChild(toolNamesList);
    body.appendChild(toolNamesSection);
  }

  // Message history
  if (run.initial_messages && run.initial_messages.length > 0) {
    const histSection = document.createElement("div");
    histSection.className = "debug-section";
    const histToggle = document.createElement("div");
    histToggle.className = "debug-section-toggle";
    histToggle.textContent = `▸ Message history (${run.initial_messages.length} messages)`;
    const histContent = document.createElement("div");
    histContent.className = "hidden";
    histContent.appendChild(renderTurns(run.initial_messages));
    histToggle.addEventListener("click", () => {
      histContent.classList.toggle("hidden");
      histToggle.textContent = histContent.classList.contains("hidden")
        ? `▸ Message history (${run.initial_messages.length} messages)`
        : `▾ Message history (${run.initial_messages.length} messages)`;
    });
    histSection.appendChild(histToggle);
    histSection.appendChild(histContent);
    body.appendChild(histSection);
  }

  body.appendChild(toolSection);
  card.appendChild(header);
  card.appendChild(body);

  header.addEventListener("click", () => {
    body.classList.toggle("hidden");
    toggle.textContent = body.classList.contains("hidden") ? "▸" : "▾";
  });

  return card;
}

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


// ── Observability shell ───────────────────────────────────────────────────────

const ALL_MODES = ["chat", "post-session", "heartbeat", "self-eval", "inter-agent-message"];

const STATS_LIMIT = 100; // backend max — used for all aggregate stats

let selectedAgent = null;
let selectedLimit = 20;
let selectedFilter = "all";
let agentItemEls = {};    // name → .obs-agent-item element
let agentsData = [];      // [{name, title}]
let agentStatsCache = {}; // name → runs[] fetched at STATS_LIMIT, used only for stats

// Shell DOM refs (set once in buildShell)
let agentListEl = null;
let runPanelHeaderEl = null;
let filterBarEl = null;
let runPanelBodyEl = null;

function statusDotClass(runs) {
  if (!runs || runs.length === 0) return "grey";
  const last = runs[0].started_at;
  const diffMin = (Date.now() - last) / 60000;
  if (diffMin < 10) return "green";
  if (diffMin < 120) return "yellow";
  return "grey";
}

function agentStats(runs) {
  const count = runs.length;
  const totalIn  = runs.reduce((s, r) => s + (r.input_tokens  || 0), 0);
  const totalOut = runs.reduce((s, r) => s + (r.output_tokens || 0), 0);
  const totalCost = runs.reduce((s, r) => s + (calcCost(r) ?? 0), 0);
  return { count, totalIn, totalOut, totalCost };
}

function buildShell() {
  container.innerHTML = "";

  // Agent list lives in the sidebar
  agentListEl = document.getElementById("monitor-agent-list");
  agentListEl.innerHTML = "";

  // Run panel fills the main content area
  runPanelHeaderEl = document.createElement("div");
  runPanelHeaderEl.className = "obs-run-panel-header";

  filterBarEl = document.createElement("div");
  filterBarEl.className = "obs-filter-bar debug-filter-bar";

  runPanelBodyEl = document.createElement("div");
  runPanelBodyEl.className = "obs-run-panel-body";

  const runPanel = document.createElement("div");
  runPanel.className = "obs-run-panel";
  runPanel.appendChild(runPanelHeaderEl);
  runPanel.appendChild(filterBarEl);
  runPanel.appendChild(runPanelBodyEl);

  container.appendChild(runPanel);
}

function renderAgentListItems() {
  // Remove existing items (keep header)
  agentListEl.querySelectorAll(".obs-agent-item").forEach(el => el.remove());
  agentItemEls = {};

  for (const agent of agentsData) {
    const runs = agentStatsCache[agent.name] || [];
    const { count, totalIn, totalOut, totalCost } = agentStats(runs);
    const lastRun = runs.length > 0 ? runs[0].started_at : null;
    const dotClass = statusDotClass(runs);

    const item = document.createElement("div");
    item.className = "obs-agent-item" + (selectedAgent?.name === agent.name ? " selected" : "");

    const nameLine = document.createElement("div");
    nameLine.className = "obs-agent-item-name";
    const dot = document.createElement("span");
    dot.className = `obs-status-dot ${dotClass}`;
    nameLine.appendChild(dot);
    nameLine.appendChild(document.createTextNode(agent.title || agent.name));

    const meta = document.createElement("div");
    meta.className = "obs-agent-item-meta";
    const parts = [];
    if (count > 0) parts.push(`${count}${runs.length === STATS_LIMIT ? "+" : ""} run${count !== 1 ? "s" : ""}`);
    if (totalCost > 0) parts.push(fmtCost(totalCost));
    if (lastRun) parts.push(relativeTime(lastRun));
    meta.textContent = parts.join(" · ") || "no runs";

    item.appendChild(nameLine);
    item.appendChild(meta);
    item.addEventListener("click", () => {
      // Show runs panel, clear any active tab highlight
      document.querySelectorAll(".agents-tab-panel").forEach(p => p.classList.add("hidden"));
      document.getElementById("agents-runs-panel")?.classList.remove("hidden");
      document.querySelectorAll(".monitor-nav-btn").forEach(b => b.classList.remove("active"));
      selectAgent(agent);
    });
    agentListEl.appendChild(item);
    agentItemEls[agent.name] = item;
  }

}

function isTaskOverdue(task, nowSec) {
  const dueAt = task.due_at;
  if (dueAt == null) return false;
  if (task.last_run == null) return dueAt <= nowSec;
  if (task.cadence_hours == null) return false; // one-off, completed
  return task.last_run + task.cadence_hours * 3600 <= nowSec;
}

function renderDefinitionSection(agent, defData) {
  // Remove any existing def block from header
  runPanelHeaderEl.querySelectorAll(".obs-def-inheader").forEach(el => el.remove());

  const block = document.createElement("div");
  block.className = "obs-def-inheader";

  // Description
  if (agent.description) {
    const desc = document.createElement("div");
    desc.className = "obs-def-desc";
    desc.textContent = agent.description;
    block.appendChild(desc);
  }

  // Model / reasoning config line
  const modelStr  = agent.model           ? `Model: ${agent.model}`             : "Model: global";
  const bgModel   = agent.backgroundModel ? `BG: ${agent.backgroundModel}`      : null;
  const reasoning = agent.reasoning?.effort ? `Reasoning: ${agent.reasoning.effort}` : null;
  const configLine = document.createElement("div");
  configLine.className = "obs-def-config";
  configLine.textContent = [modelStr, bgModel, reasoning].filter(Boolean).join("  ·  ");
  block.appendChild(configLine);

  // Tools filter line
  if (agent.tools) {
    const names  = agent.tools.names || [];
    const shown  = names.slice(0, 5).join(", ");
    const rest   = names.length > 5 ? ` +${names.length - 5} more` : "";
    const toolsLine = document.createElement("div");
    toolsLine.className = "obs-def-config";
    toolsLine.textContent = `Tools: ${agent.tools.mode} [${shown}${rest}]`;
    toolsLine.title = names.join(", ");
    block.appendChild(toolsLine);
  }

  // Identity prompt (collapsible)
  if (defData?.identityText) {
    const [t, p] = makeTogglePre(
      `▸ Identity  (${defData.identityText.length.toLocaleString()} chars)`,
      `▾ Identity  (${defData.identityText.length.toLocaleString()} chars)`,
      defData.identityText
    );
    t.className = "obs-def-prompt-toggle";
    p.className = "debug-prompt hidden";
    block.appendChild(t);
    block.appendChild(p);
  }

  // Background-mode prompts (one per trigger)
  if (defData?.backgroundModePrompts) {
    for (const [trigger, text] of Object.entries(defData.backgroundModePrompts)) {
      if (!text) continue;
      const [t, p] = makeTogglePre(
        `▸ ${trigger}  (${text.length.toLocaleString()} chars)`,
        `▾ ${trigger}  (${text.length.toLocaleString()} chars)`,
        text
      );
      t.className = "obs-def-prompt-toggle";
      p.className = "debug-prompt hidden";
      block.appendChild(t);
      block.appendChild(p);
    }
  }

  runPanelHeaderEl.appendChild(block);
}

async function selectAgent(agent, silent = false) {
  selectedAgent = agent;
  if (!silent) {
    selectedLimit = 20;
    selectedFilter = "all";
  }

  // Highlight sidebar item
  Object.values(agentItemEls).forEach(el => el.classList.remove("selected"));
  if (agentItemEls[agent.name]) agentItemEls[agent.name].classList.add("selected");

  // Fetch panel display runs, stats runs, and definition in parallel
  let runs, statsRuns, agentDef;
  try {
    [runs, statsRuns, agentDef] = await Promise.all([
      fetch(`/api/agents/${agent.name}/runs?limit=${selectedLimit}`).then(r => r.json()),
      fetch(`/api/agents/${agent.name}/runs?limit=${STATS_LIMIT}`).then(r => r.json()),
      fetch(`/api/agents/${agent.name}/definition`).then(r => r.json()).catch(() => null),
    ]);
  } catch {
    runs = []; statsRuns = []; agentDef = null;
  }

  // Update stats cache and sidebar
  agentStatsCache[agent.name] = statsRuns;
  renderAgentListItems();

  // Render header — stats always from the full STATS_LIMIT fetch
  runPanelHeaderEl.innerHTML = "";

  const infoEl = document.createElement("div");
  infoEl.className = "obs-agent-info";

  const titleEl = document.createElement("div");
  titleEl.className = "obs-agent-title";
  titleEl.textContent = agent.title || agent.name;

  const { count, totalIn, totalOut, totalCost } = agentStats(statsRuns);
  const hasTokens = totalIn > 0 || totalOut > 0;
  const subtitleEl = document.createElement("div");
  subtitleEl.className = "obs-agent-subtitle";
  const subtitleParts = [`${count}${statsRuns.length === STATS_LIMIT ? "+" : ""} run${count !== 1 ? "s" : ""}`];
  if (hasTokens) subtitleParts.push(`${fmtTokens(totalIn)}↑ ${fmtTokens(totalOut)}↓`);
  if (totalCost > 0) subtitleParts.push(fmtCost(totalCost));
  if (statsRuns.length === STATS_LIMIT) subtitleParts.push("last 100");
  subtitleEl.textContent = subtitleParts.join(" · ");

  infoEl.appendChild(titleEl);
  infoEl.appendChild(subtitleEl);
  runPanelHeaderEl.appendChild(infoEl);

  // Trigger buttons
  const btnsDiv = document.createElement("div");
  btnsDiv.className = "obs-trigger-btns";
  for (const [label, eventType] of [["Heartbeat", "heartbeat_trigger"], ["Self-Eval", "self_eval_trigger"]]) {
    const btn = document.createElement("button");
    btn.className = "debug-trigger-btn";
    btn.textContent = label;
    btn.addEventListener("click", async () => {
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
  runPanelHeaderEl.appendChild(btnsDiv);

  // Render definition (description + config + prompt toggles) into the header
  renderDefinitionSection(agent, agentDef);

  // Render filter bar
  renderFilterBar(runs);

  // Render run cards
  renderRunCards(runs);
}

function renderFilterBar(runs) {
  filterBarEl.innerHTML = "";

  const runCount = document.createElement("span");
  runCount.className = "debug-run-count";

  for (const mode of ["all", ...ALL_MODES]) {
    const btn = document.createElement("button");
    btn.className = "debug-filter-btn" + (mode === selectedFilter ? " active" : "");
    btn.textContent = mode;
    btn.dataset.mode = mode;
    btn.addEventListener("click", () => {
      selectedFilter = mode;
      filterBarEl.querySelectorAll(".debug-filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      // Re-render cards with current runs (re-fetch not needed)
      fetch(`/api/agents/${selectedAgent.name}/runs?limit=${selectedLimit}`)
        .then(r => r.json())
        .then(runs => renderRunCards(runs))
        .catch(() => {});
    });
    filterBarEl.appendChild(btn);
  }
  filterBarEl.appendChild(runCount);
}

function renderRunCards(allRuns) {
  runPanelBodyEl.innerHTML = "";

  const filtered = selectedFilter === "all"
    ? allRuns
    : allRuns.filter(r => r.mode === selectedFilter || r.mode.startsWith(selectedFilter + " "));

  // Update run count in filter bar
  const runCountEl = filterBarEl.querySelector(".debug-run-count");
  if (runCountEl) {
    const totalIn  = filtered.reduce((s, r) => s + (r.input_tokens  || 0), 0);
    const totalOut = filtered.reduce((s, r) => s + (r.output_tokens || 0), 0);
    const totalCost = filtered.reduce((s, r) => s + (calcCost(r) ?? 0), 0);
    const hasTokens = totalIn > 0 || totalOut > 0;
    runCountEl.textContent = hasTokens
      ? `${filtered.length} run${filtered.length !== 1 ? "s" : ""} · ${fmtTokens(totalIn)}↑ ${fmtTokens(totalOut)}↓ · ${fmtCost(totalCost)}`
      : `${filtered.length} run${filtered.length !== 1 ? "s" : ""}`;
  }

  if (filtered.length === 0) {
    runPanelBodyEl.innerHTML = `<div class="debug-empty">No ${selectedFilter === "all" ? "" : selectedFilter + " "}runs recorded.</div>`;
    return;
  }

  filtered.forEach(run => runPanelBodyEl.appendChild(renderRun(run)));

  // Load more button
  const loadMore = document.createElement("button");
  loadMore.className = "debug-load-more";
  loadMore.textContent = "Load more";
  loadMore.addEventListener("click", async () => {
    selectedLimit = Math.min(selectedLimit + 20, 100);
    loadMore.disabled = true;
    loadMore.textContent = "Loading…";
    try {
      const runs = await fetch(`/api/agents/${selectedAgent.name}/runs?limit=${selectedLimit}`).then(r => r.json());
      agentRunsCache[selectedAgent.name] = runs;
      renderRunCards(runs);
    } catch {
      loadMore.textContent = "Load more";
      loadMore.disabled = false;
    }
  });
  runPanelBodyEl.appendChild(loadMore);
}

async function refreshAgentList() {
  await Promise.all(
    agentsData.map(a =>
      fetch(`/api/agents/${a.name}/runs?limit=${STATS_LIMIT}`)
        .then(r => r.json())
        .then(runs => { agentStatsCache[a.name] = runs; })
        .catch(() => {})
    )
  );
  renderAgentListItems();
}


// ── Task board tab ─────────────────────────────────────────────────────────────

export async function loadTaskBoard() {
  const boardEl = document.getElementById("agent-tasks-board");
  boardEl.innerHTML = `<div class="debug-loading">Loading tasks…</div>`;

  let tasks;
  try {
    ({ tasks } = await fetch("/api/agents/tasks").then(r => r.json()));
  } catch {
    boardEl.innerHTML = `<div class="debug-empty">Failed to load tasks.</div>`;
    return;
  }

  boardEl.innerHTML = "";

  if (!tasks?.length) {
    boardEl.innerHTML = `<div class="debug-empty">No tasks on the board.</div>`;
    return;
  }

  const nowSec = Date.now() / 1000;

  // Sort: overdue → active → done
  tasks.sort((a, b) => {
    const aOver = isTaskOverdue(a, nowSec), bOver = isTaskOverdue(b, nowSec);
    const aDone = a.last_run != null && a.cadence_hours == null;
    const bDone = b.last_run != null && b.cadence_hours == null;
    if (aOver !== bOver) return aOver ? -1 : 1;
    if (aDone !== bDone) return aDone ? 1 : -1;
    return 0;
  });

  // Summary header
  const overdueCount = tasks.filter(t => isTaskOverdue(t, nowSec)).length;
  const summaryEl = document.createElement("div");
  summaryEl.className = "obs-task-summary";
  summaryEl.textContent = overdueCount > 0
    ? `${tasks.length} tasks · ${overdueCount} overdue`
    : `${tasks.length} tasks`;
  boardEl.appendChild(summaryEl);

  const table = document.createElement("div");
  table.className = "obs-tasks-body";

  // Header row
  const headerRow = document.createElement("div");
  headerRow.className = "obs-task-row obs-task-header";
  for (const label of ["task", "assignee", "by", "schedule", "last run", ""]) {
    const cell = document.createElement("span");
    cell.className = "obs-task-meta";
    cell.textContent = label;
    headerRow.appendChild(cell);
  }
  table.appendChild(headerRow);

  for (const t of tasks) {
    const overdue = isTaskOverdue(t, nowSec);
    const oneOffDone = t.last_run != null && t.cadence_hours == null;

    // Compute next due for recurring tasks
    const nextDueSec = t.last_run != null && t.cadence_hours != null
      ? t.last_run + t.cadence_hours * 3600
      : null;

    const schedule = t.cadence_hours != null
      ? `every ${t.cadence_hours}h`
      : t.due_at != null
        ? `due ${new Date(t.due_at * 1000).toLocaleDateString([], { month: "short", day: "numeric" })}`
        : "—";

    const lastRunStr = t.last_run ? relativeTime(t.last_run * 1000) : "never";

    const row = document.createElement("div");
    row.className = "obs-task-row";

    // Name cell: two lines
    const nameEl = document.createElement("span");
    nameEl.className = "obs-task-name-cell";
    nameEl.title = t.description || "";
    nameEl.innerHTML =
      `<span class="obs-task-name-main">${t.name}</span>` +
      (t.description ? `<span class="obs-task-name-sub">${t.description}</span>` : "");

    const assigneeEl = document.createElement("span");
    assigneeEl.className = "obs-task-meta";
    assigneeEl.textContent = t.assignee || "—";

    const createdByEl = document.createElement("span");
    createdByEl.className = "obs-task-meta";
    createdByEl.textContent = t.created_by || "—";

    const scheduleEl = document.createElement("span");
    scheduleEl.className = "obs-task-meta";
    scheduleEl.textContent = schedule;

    const lastEl = document.createElement("span");
    lastEl.className = "obs-task-meta";
    lastEl.textContent = lastRunStr;

    const statusEl = document.createElement("span");
    statusEl.className = "obs-task-badge" + (overdue ? " overdue" : oneOffDone ? " done" : " ok");
    statusEl.textContent = overdue ? "overdue" : oneOffDone ? "done" : "✓";

    row.appendChild(nameEl);
    row.appendChild(assigneeEl);
    row.appendChild(createdByEl);
    row.appendChild(scheduleEl);
    row.appendChild(lastEl);
    row.appendChild(statusEl);
    table.appendChild(row);
  }

  boardEl.appendChild(table);
}


// ── Entry point ───────────────────────────────────────────────────────────────

export async function load() {
  container.innerHTML = `<div class="debug-loading">Loading agents…</div>`;
  try {
    agentsData = await fetch("/api/agents").then(r => r.json());

    if (agentsData.length === 0) {
      container.innerHTML = `<div class="debug-empty">No agents registered.</div>`;
      return;
    }

    // Fetch up to STATS_LIMIT runs per agent for sidebar stats
    await Promise.all(
      agentsData.map(a =>
        fetch(`/api/agents/${a.name}/runs?limit=${STATS_LIMIT}`)
          .then(r => r.json())
          .then(runs => { agentStatsCache[a.name] = runs; })
          .catch(() => { agentStatsCache[a.name] = []; })
      )
    );

    buildShell();
    renderAgentListItems();
    await selectAgent(agentsData[0]);

    // Live refresh via event bus
    const es = new EventSource("/api/events");
    es.onmessage = async e => {
      try {
        const ev = JSON.parse(e.data);
        if (["session_closed", "heartbeat_trigger", "self_eval_trigger", "agent_run"].includes(ev.type)) {
          await refreshAgentList();
          if (selectedAgent) await selectAgent(selectedAgent, true);
        }
      } catch { /* ignore */ }
    };

  } catch (err) {
    container.innerHTML = `<div class="debug-empty">Failed to load: ${escHtml(err.message)}</div>`;
  }
}
