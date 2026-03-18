# lifeos

A personal life-OS agent. Spring Boot + WebFlux backend with a vanilla JS frontend, wrapping Claude into a persistent, self-learning personal assistant.

## Prerequisites

- **Java 25** (OpenJDK) — see install instructions below
- **Anthropic API key** — get one at https://console.anthropic.com

## Setup

### 1. Install Java 25

**macOS (Homebrew)**
```bash
brew install openjdk
```

**Windows**
Download and install the OpenJDK 25 MSI from https://adoptium.net. The installer sets `JAVA_HOME` automatically.

---

### 2. Clone the repo

```bash
git clone https://github.com/shreyjairath/lifeos.git
cd lifeos
git checkout java-port
```

---

### 3. Set environment variables

**macOS / Linux**
```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home
export ANTHROPIC_API_KEY=your_api_key_here
```

**Windows (Command Prompt)**
```cmd
set JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-25
set ANTHROPIC_API_KEY=your_api_key_here
```

**Windows (PowerShell)**
```powershell
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-25"
$env:ANTHROPIC_API_KEY = "your_api_key_here"
```

> Adjust `JAVA_HOME` to match your actual JDK install path.

---

### 4. Run

**macOS / Linux**
```bash
./gradlew bootRun
```

**Windows**
```cmd
gradlew.bat bootRun
```

---

### 5. Open the app

Navigate to **http://localhost:8000**

---

## Notes

- Runtime data (agent workspaces, session history, notes) is stored in `.user-data/` — gitignored.
- Frontend changes (JS/CSS/HTML) take effect immediately — just reload the page.
- Java changes trigger an automatic restart via Spring DevTools.
- Default models: `claude-sonnet-4-6` for chat, `claude-opus-4-6` for reflection and self-eval.
- To override config, edit `src/main/resources/application.yml` or set environment variables.
