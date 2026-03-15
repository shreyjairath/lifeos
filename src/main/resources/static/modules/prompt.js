const promptFileList = document.getElementById("prompt-file-list");
const promptEditor = document.getElementById("prompt-editor");
const promptSaveBtn = document.getElementById("prompt-save-btn");
const promptSaveStatus = document.getElementById("prompt-save-status");

let activeFile = null;

async function selectFile(name) {
  activeFile = name;
  promptFileList.querySelectorAll(".prompt-file-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.name === name);
  });
  const resp = await fetch(`/api/prompt-parts/${name}`);
  const data = await resp.json();
  promptEditor.value = data.content;
  promptSaveStatus.textContent = "";
}

export async function load() {
  const resp = await fetch("/api/prompt-parts");
  if (!resp.ok) return;
  const data = await resp.json();
  if (!Array.isArray(data.parts)) return;

  promptFileList.innerHTML = "";
  for (const name of data.parts) {
    const btn = document.createElement("button");
    btn.className = "prompt-file-btn";
    btn.dataset.name = name;
    btn.title = name;
    btn.textContent = name.replace(/\.md$/, "");
    btn.addEventListener("click", () => selectFile(name));
    promptFileList.appendChild(btn);
  }

  if (data.parts[0]) selectFile(data.parts[0]);
}

export function init() {
  promptSaveBtn.addEventListener("click", async () => {
    if (!activeFile) return;
    promptSaveBtn.disabled = true;
    const resp = await fetch(`/api/prompt-parts/${activeFile}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: promptEditor.value }),
    });
    promptSaveBtn.disabled = false;
    promptSaveStatus.textContent = resp.ok ? "Saved" : "Error";
    setTimeout(() => { promptSaveStatus.textContent = ""; }, 2000);
  });
}
