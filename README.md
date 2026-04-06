# lifeos

A personal life-OS agent platform. Bun/Hono server + Next.js frontend, wrapping the Anthropic API into a persistent multi-agent personal assistant.

## Prerequisites

- **Bun** — https://bun.sh
- **Anthropic API key** (or OpenRouter key)

### Installing Bun

**macOS / Linux:**
```bash
curl -fsSL https://bun.sh/install | bash
```

**Windows** (PowerShell, run as Administrator):
```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/shreyjairath/lifeos.git
cd lifeos
git checkout ts-port-clean
```

### 2. Install dependencies

```bash
bun install
```

### 3. Configure

Copy or create `config.yml` at the repo root. Set your API key as an environment variable:

```bash
export ANTHROPIC_API_KEY=your_key_here
# or
export OPENROUTER_API_KEY=your_key_here
```

#### `config.yml` reference

```yaml
server:
  port: 8000                        # optional — default 8000; override with PORT env var

lifeos:
  # ── Required ──────────────────────────────────────────────────────
  model: claude-sonnet-4-6          # model for chat and inter-agent messages
  background-model: claude-haiku-4-5-20251001  # model for heartbeat, log-process, summarization

  # ── Email (optional — needed for email tools) ──────────────────────
  client-email: you@gmail.com       # your personal email — default recipient for agent emails
  mailbox-email: agents@gmail.com   # shared mailbox all agents send from (Gmail OAuth required)
  contacts:                         # route inbound emails to specific agents by sender
    - email: person@example.com
      agents: [cos, advisor]        # agents that handle emails from this sender
      fallback: cos                 # agent to use if no @mention found in thread

  # ── Model options (optional) ───────────────────────────────────────
  reasoning:
    effort: medium                  # extended thinking effort: low | medium | high
    max-tokens: 10000               # max thinking tokens (alternative to effort)

  # ── Session management (optional — defaults shown) ─────────────────
  session:
    token-threshold: 100000         # rotate session after this many input tokens
    time-threshold-hours: 4         # rotate session after this many hours of inactivity

  # ── Scheduler crons (optional — defaults shown) ────────────────────
  heartbeat:
    cron: "0 0 */4 * * *"          # heartbeat trigger cadence (every 4h)
  session-expiry-check:
    cron: "0 0 * * * *"            # session expiry check cadence (every 1h)
```

#### Gmail setup (optional)

To enable email tools (`read_emails`, `send_email`, `read_email_thread`), you need a Gmail OAuth refresh token.

**1. Create a Google Cloud project**
1. Go to https://console.cloud.google.com
2. Create a new project (or select an existing one)
3. Go to **APIs & Services → Library**, search for **Gmail API**, and enable it

**2. Create OAuth credentials**
1. Go to **APIs & Services → Credentials**
2. Click **Create Credentials → OAuth client ID**
3. Set application type to **Desktop app**, give it a name, click **Create**
4. Download the credentials JSON — note the `client_id` and `client_secret`

**3. Configure the OAuth consent screen**
1. Go to **APIs & Services → OAuth consent screen**
2. Set user type to **External**, fill in app name and your email
3. Add scope: `https://www.googleapis.com/auth/gmail.modify`
4. Add your Gmail address as a test user

**4. Get a refresh token**

Use the OAuth Playground at https://developers.google.com/oauthplayground:
1. Click the settings gear (top right) → check **Use your own OAuth credentials**
2. Enter your `client_id` and `client_secret`
3. In the left panel, find **Gmail API v1** and select `https://www.googleapis.com/auth/gmail.modify`
4. Click **Authorize APIs** → sign in with the Gmail account agents will use
5. Click **Exchange authorization code for tokens**
6. Copy the `refresh_token` from the response

**5. Create the credentials file**

Create `.user-data/system/gmail-credentials.json`:
```json
{
  "clientId": "your_client_id",
  "clientSecret": "your_client_secret",
  "refreshToken": "your_refresh_token"
}
```

Set `mailbox-email` in `config.yml` to the Gmail address you authorized.

### 4. Run

```bash
bun run dev
```

### 5. Open the app

Navigate to **http://localhost:3000**

---

## Notes

- Runtime data (sessions, agent workspaces, topics) is stored in `.user-data/` — gitignored.
- Server runs on port 8000, Next.js frontend on port 3000.
- Frontend proxies API requests to the server automatically in dev.
- Built-in agents live in `agents/`. Dynamic agents are created at runtime in `.user-data/agents/`.
- Agent tool access, recurring tasks, and identity are configured in each agent's `agent.yml`.
