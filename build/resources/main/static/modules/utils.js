export function renderMarkdown(text) {
  let out = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  out = out.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code>${code.trim()}</code></pre>`);

  out = out.replace(/^(\|.+)\n(\|[-| :]+)\n((?:\|.+\n?)*)/gm, (_, header, sep, body) => {
    const parseRow = row => row.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
    const cols = parseRow(sep).map(c => {
      if (c.startsWith(":") && c.endsWith(":")) return 'style="text-align:center"';
      if (c.endsWith(":")) return 'style="text-align:right"';
      return "";
    });
    const th = parseRow(header).map((c, i) => `<th ${cols[i]}>${c}</th>`).join("");
    const rows = body.trim().split("\n").map(row =>
      `<tr>${parseRow(row).map((c, i) => `<td ${cols[i]}>${c}</td>`).join("")}</tr>`
    ).join("");
    return `<table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`;
  });

  out = out
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>)/gs, "<ul>$1</ul>")
    .replace(/\n{2,}/g, "<br><br>")
    .replace(/\n/g, "<br>");

  return out;
}

export function highlightJson(obj) {
  const raw = JSON.stringify(obj, null, 2);
  return raw.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      if (/^"/.test(match)) {
        if (/:$/.test(match)) return `<span class="json-key">${match}</span>`;
        return `<span class="json-string">${match}</span>`;
      }
      if (/true|false/.test(match)) return `<span class="json-bool">${match}</span>`;
      if (/null/.test(match)) return `<span class="json-null">${match}</span>`;
      return `<span class="json-number">${match}</span>`;
    }
  );
}
