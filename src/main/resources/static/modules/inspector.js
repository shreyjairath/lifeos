import { highlightJson } from "./utils.js";

const inspectorBody = document.getElementById("inspector-body");
const inspectorCopy = document.getElementById("inspector-copy");

let lastRequestPayload = null;
let pendingRequestPayload = null;

function makeSection(classes, label, meta, bodyHtml) {
  return `
    <div class="isp-section ${classes}">
      <div class="isp-head">
        <span class="isp-label">${label}</span>
        ${meta ? `<span class="isp-meta">${meta}</span>` : ""}
      </div>
      <div class="isp-body">${bodyHtml}</div>
    </div>`;
}

function update(reqPayload, resPayload) {
  lastRequestPayload = { request: reqPayload, response: resPayload };

  const modelHtml = `<div class="isp-section model">
    <div class="isp-head"><span class="isp-label">Model</span></div>
    <div class="isp-model-val">${reqPayload.model}</div>
  </div>`;

  const sysText = (reqPayload.system || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const sysChars = (reqPayload.system || "").length;
  const sysSection = makeSection("grow", "System Prompt", `${sysChars.toLocaleString()} chars`, sysText);

  const toolsMeta = `${(reqPayload.tools || []).length} tools`;
  const toolsSection = makeSection("grow", "Tools", toolsMeta, highlightJson(reqPayload.tools || []));

  const msgs = reqPayload.messages || [];
  const msgsMeta = `${msgs.length} turn${msgs.length !== 1 ? "s" : ""}`;
  const msgsSection = makeSection("grow-2", "Messages", msgsMeta, highlightJson(msgs));

  const usage = resPayload.usage ? `${resPayload.usage.input_tokens} in / ${resPayload.usage.output_tokens} out` : "";
  const resMeta = [resPayload.stop_reason, usage].filter(Boolean).join(" · ");
  const resSection = makeSection("grow", "Response", resMeta, highlightJson(resPayload.content || []));

  inspectorBody.innerHTML = modelHtml + sysSection + toolsSection + msgsSection + resSection;
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
