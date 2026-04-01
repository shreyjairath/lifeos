# lifeos

A personal life-OS agent platform. Bun/Hono server + Next.js frontend, wrapping OpenRouter into a persistent multi-agent personal assistant.

## Prerequisites

- **Bun** — https://bun.sh
- **OpenRouter API key** — https://openrouter.ai

### Installing Bun

**macOS / Linux:**
```bash
curl -fsSL https://bun.sh/install | bash
```

**Windows** (PowerShell, run as Administrator):
```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```
Then restart your terminal. Bun on Windows requires Windows 10 version 1809 or later.

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/shreyjairath/lifeos.git
cd lifeos
git checkout ts-port
```

### 2. Install dependencies

```bash
bun install
```

### 3. Configure

Set your API key as an environment variable:

**macOS / Linux:**
```bash
export OPENROUTER_API_KEY=your_openrouter_api_key_here
```

**Windows (PowerShell):**
```powershell
$env:OPENROUTER_API_KEY="your_openrouter_api_key_here"
```

Edit `config.yml` to customize the model, port, MCP servers, and other settings.

### 4. Run

```bash
bun run dev
```

### 5. Open the app

Navigate to **http://localhost:3000**

---

## Notes

- Runtime data (sessions, agent workspaces) is stored in `.user-data/` — gitignored.
- Server runs on port 8000, Next.js frontend on port 3000.
- Frontend proxies API requests to the server automatically in dev.
- To override the server port, set `PORT` env var or edit `config.yml`.
