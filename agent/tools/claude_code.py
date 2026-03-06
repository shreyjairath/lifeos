"""Claude Code tool — runs claude -p in print mode as a subprocess."""
import shutil
import subprocess
from pathlib import Path
from typing import Optional


def _find_claude() -> str:
    found = shutil.which("claude")
    if found:
        return found
    candidates = [
        Path.home() / ".local" / "bin" / "claude",
        Path.home() / ".npm-global" / "bin" / "claude",
        Path.home() / "node_modules" / ".bin" / "claude",
        Path("/usr/local/bin/claude"),
        Path("/opt/homebrew/bin/claude"),
        Path("/opt/homebrew/opt/node/bin/claude"),
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    return "claude"


CLAUDE_BIN = _find_claude()


def run_claude_code(prompt: str, working_dir: Optional[str] = None) -> dict:
    """Run a Claude Code task in non-interactive print mode and return the output."""
    cwd = working_dir or str(Path(__file__).parent.parent.parent)
    try:
        result = subprocess.run(
            [CLAUDE_BIN, "-p", prompt],
            capture_output=True,
            text=True,
            cwd=cwd,
            timeout=120,
        )
        return {
            "output": result.stdout.strip(),
            "error": result.stderr.strip() or None,
            "returncode": result.returncode,
            "working_dir": cwd,
        }
    except FileNotFoundError:
        return {"error": "claude CLI not found. Install Claude Code and ensure it is in PATH."}
    except subprocess.TimeoutExpired:
        return {"error": "Claude Code task timed out after 120 seconds."}
    except Exception as e:
        return {"error": str(e)}
