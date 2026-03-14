const promptFileList = document.getElementById("prompt-file-list");
const promptEditor = document.getElementById("prompt-editor");
const promptSaveBtn = document.getElementById("prompt-save-btn");
const promptSaveStatus = document.getElementById("prompt-save-status");

let activeFile = null;
let activeInstructions = null;

async function selectFile(name) {
  activeFile = name;
  promptFileList.querySelectorAll(".prompt-file-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.name === name);
  });
  const resp = await fetch(`/api/prompt-parts/${name}`);
  const data = await resp.json();
  promptEditor.value = data.content;
  promptSaveStatus.textContent = "";
  updateSetActiveBtn();
}

function updateSetActiveBtn() {
  const btn = document.getElementById("prompt-set-active-btn");
  if (!btn) return;
  const isActive = activeFile === activeInstructions;
  btn.textContent = isActive ? "Active" : "Set as active";
  btn.disabled = isActive;
}

function refreshBadges() {
  promptFileList.querySelectorAll(".prompt-active-badge").forEach(b => b.remove());
  promptFileList.querySelectorAll(".prompt-file-btn").forEach(b => {
    if (b.dataset.name === activeInstructions) {
      const badge = document.createElement("span");
      badge.className = "prompt-active-badge";
      badge.textContent = "active";
      b.appendChild(badge);
    }
  });
}

export async function load() {
  const resp = await fetch("/api/prompt-parts");
  const data = await resp.json();
  activeInstructions = data.active;

  promptFileList.innerHTML = "";
  for (const name of data.parts) {
    const btn = document.createElement("button");
    btn.className = "prompt-file-btn";
    btn.dataset.name = name;
    btn.title = name;

    const label = document.createElement("span");
    label.textContent = name.replace(/\.md$/, "");
    btn.appendChild(label);

    if (name === activeInstructions) {
      const badge = document.createElement("span");
      badge.className = "prompt-active-badge";
      badge.textContent = "active";
      btn.appendChild(badge);
    }

    btn.addEventListener("click", () => selectFile(name));
    promptFileList.appendChild(btn);
  }

  const defaultFile = activeInstructions && data.parts.includes(activeInstructions)
    ? activeInstructions : data.parts[0];
  if (defaultFile) selectFile(defaultFile);
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

  const setActiveBtn = document.getElementById("prompt-set-active-btn");
  if (setActiveBtn) {
    setActiveBtn.addEventListener("click", async () => {
      if (!activeFile) return;
      const resp = await fetch("/api/active-instructions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: activeFile }),
      });
      if (resp.ok) {
        activeInstructions = activeFile;
        refreshBadges();
        updateSetActiveBtn();
      }
    });
  }
}
