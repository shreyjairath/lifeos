# lifeos

A personal life-OS agent platform. Bun/Hono server + Next.js frontend, wrapping OpenRouter into a persistent multi-agent personal assistant.

## Prerequisites

- **Bun** — https://bun.sh
- **OpenRouter API key** — https://openrouter.ai

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

```bash
export OPENROUTER_API_KEY=your_openrouter_api_key_here
```

Copy `config.example.yml` to `config.yml` to customize model, port, and other settings:

```bash
cp config.example.yml config.yml
```

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
