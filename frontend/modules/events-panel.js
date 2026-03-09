const eventsBody = document.getElementById("events-body");

const EVENT_FORMATS = {
  boot_start:          () => ({ badge: "boot",       detail: "Boot sequence started" }),
  boot_done:           () => ({ badge: "boot",       detail: "Boot complete" }),
  knowledge_file:      e  => ({ badge: "knowledge",  detail: `${e.file} — ${e.status}${e.chars ? ` (${e.chars.toLocaleString()} chars)` : ""}` }),
  onboarding_status:   e  => ({ badge: "onboarding", detail: `${e.file} — ${e.status}` }),
  system_prompt:       e  => ({ badge: "prompt",     detail: `System prompt assembled (${e.chars.toLocaleString()} chars)` }),
  session_start:       e  => ({ badge: "session",    detail: `Session started — ${e.session_id}` }),
  session_end:         e  => ({ badge: "session",    detail: `Session ended — ${e.session_id}` }),
  llm_request:         e  => ({ badge: "llm",        detail: `→ ${e.model} (${e.messages} messages)` }),
  llm_response:        e  => ({ badge: "llm",        detail: `← ${e.stop_reason} · ${e.input_tokens} in / ${e.output_tokens} out` }),
  tool_use:            e  => ({ badge: "tool_use",   detail: `${e.name} — Claude requested` }),
  tool_call:           e  => ({ badge: "tool",       detail: `${e.name}(${JSON.stringify(e.input)})` }),
  tool_result:         e  => ({ badge: "result",     detail: `${e.name} → ${JSON.stringify(e.result).slice(0, 120)}` }),
  knowledge_updated:   e  => ({ badge: "write",      detail: `${e.file} updated (${e.chars.toLocaleString()} chars)` }),
  onboarding_updated:  e  => ({ badge: "onboarding", detail: `${e.file} marked ${e.status}` }),
  onboarding_complete: () => ({ badge: "onboarding", detail: "Onboarding complete" }),
  prompt_part_updated: e  => ({ badge: "prompt",     detail: `${e.name} updated (${e.chars.toLocaleString()} chars)` }),
  cc_request:          e  => ({ badge: "cc",         detail: `→ ${e.message.slice(0, 80)}` }),
  cc_response:         e  => ({ badge: "cc",         detail: `← ${e.chars.toLocaleString()} chars · session ${e.session_id?.slice(0, 8)}` }),
  reflection:          e  => ({ badge: "memory",     detail: e.summary?.slice(0, 120) }),
  session_rotate:           e  => ({ badge: "session", detail: `Rotating — ${e.reason}` }),
  session_summary_written:  e  => ({ badge: "memory",  detail: `Session summary written (${e.chars} chars)` }),
};

export function appendEvent(event) {
  const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const formatter = EVENT_FORMATS[event.type];
  const { badge, detail } = formatter ? formatter(event) : { badge: event.type, detail: JSON.stringify(event) };

  const row = document.createElement("div");
  row.className = `ev-row ev-${event.type.replace(/_/g, "-")}`;
  row.innerHTML = `<span class="ev-ts">${ts}</span><span class="ev-badge">${badge}</span><span class="ev-detail">${detail}</span>`;
  eventsBody.appendChild(row);
  eventsBody.scrollTop = eventsBody.scrollHeight;
}

export function connect() {
  const source = new EventSource("/api/events");
  source.onmessage = (e) => {
    try { appendEvent(JSON.parse(e.data)); } catch {}
  };
  source.onerror = () => {
    // EventSource auto-reconnects on error
  };
}
