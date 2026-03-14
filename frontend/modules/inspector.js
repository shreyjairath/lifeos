import { highlightJson } from "./utils.js";

const inspectorBody = document.getElementById("inspector-body");
const inspectorCopy = document.getElementById("inspector-copy");

let lastRequestPayload = null;
let pendingRequestPayload = null;

function makeSection(classes, label, meta, bodyHtml, resizable = false) {
  return `
    <div class="isp-section ${classes}">
      <div class="isp-head">
        <span class="isp-label">${label}</span>
        ${meta ? `<span class="isp-meta">${meta}</span>` : ""}
      </div>
      <div class="isp-body">${bodyHtml}</div>
      ${resizable ? `<div class="isp-drag-handle"></div>` : ""}
    </div>`;
}

function renderSystemPrompt(text) {
  const lines = text.split("\n");
  let html = "";
  for (const line of lines) {
    const esc = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (line.startsWith("# ")) {
      html += `<div class="isp-sys-h1">${esc.slice(2)}</div>`;
    } else if (line.startsWith("## ")) {
      html += `<div class="isp-sys-h2">${esc.slice(3)}</div>`;
    } else if (line.startsWith("### ")) {
      html += `<div class="isp-sys-h3">${esc.slice(4)}</div>`;
    } else if (line.startsWith("#### ")) {
      html += `<div class="isp-sys-h4">${esc.slice(5)}</div>`;
    } else if (line === "") {
      html += `<div class="isp-sys-gap"></div>`;
    } else {
      html += `<div class="isp-sys-line">${esc}</div>`;
    }
  }
  return `<div class="isp-sys">${html}</div>`;
}

function update(reqPayload, resPayload) {
  lastRequestPayload = { request: reqPayload, response: resPayload };

  const modelHtml = `<div class="isp-section model">
    <div class="isp-head"><span class="isp-label">Model</span><span class="isp-model-val">${reqPayload.model}</span></div>
  </div>`;

  const sysRaw = reqPayload.system || "";
  const sysChars = sysRaw.length;
  const sysHtml = renderSystemPrompt(sysRaw);
  const sysSection = makeSection("grow", "System Prompt", `${sysChars.toLocaleString()} chars`, sysHtml, true);

  const toolsMeta = `${(reqPayload.tools || []).length} tools`;
  const toolsSection = makeSection("grow", "Tools", toolsMeta, highlightJson(reqPayload.tools || []), true);

  const msgs = reqPayload.messages || [];
  const msgsMeta = `${msgs.length} turn${msgs.length !== 1 ? "s" : ""}`;
  const msgsSection = makeSection("grow-2", "Messages", msgsMeta, highlightJson(msgs), true);

  const usage = resPayload.usage ? `${resPayload.usage.input_tokens} in / ${resPayload.usage.output_tokens} out` : "";
  const resMeta = [resPayload.stop_reason, usage].filter(Boolean).join(" · ");
  const resSection = makeSection("grow", "Response", resMeta, highlightJson(resPayload.content || []));

  inspectorBody.innerHTML = modelHtml + sysSection + toolsSection + msgsSection + resSection;
  attachDragHandles();
}

function attachDragHandles() {
  inspectorBody.querySelectorAll(".isp-drag-handle").forEach(handle => {
    handle.addEventListener("mousedown", onDragStart);
  });
}

function onDragStart(e) {
  e.preventDefault();
  const handle = e.currentTarget;
  const section = handle.closest(".isp-section");
  const startY = e.clientY;
  const startHeight = section.getBoundingClientRect().height;

  handle.classList.add("dragging");

  function onMove(e) {
    const delta = e.clientY - startY;
    const newHeight = Math.max(60, startHeight + delta);
    section.style.flex = "none";
    section.style.height = newHeight + "px";
  }

  function onUp() {
    handle.classList.remove("dragging");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

export function setPendingRequest(payload) {
  pendingRequestPayload = payload;
}

export function resolveWithResponse(resPayload) {
  if (pendingRequestPayload) {
    update(pendingRequestPayload, resPayload);
    pendingRequestPayload = null;
  }
}

export function init() {
  inspectorCopy.addEventListener("click", () => {
    if (!lastRequestPayload) return;
    navigator.clipboard.writeText(JSON.stringify(lastRequestPayload, null, 2));
    inspectorCopy.textContent = "Copied!";
    setTimeout(() => { inspectorCopy.textContent = "Copy"; }, 1500);
  });
}
