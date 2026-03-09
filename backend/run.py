#!/usr/bin/env python3
import subprocess
import sys
import uvicorn

# Ensure Playwright's Chromium binary is present (no-op if already installed)
subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"], check=False)

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        reload=True,
        reload_excludes=[".venv", "__pycache__"],
        timeout_graceful_shutdown=1,
    )
