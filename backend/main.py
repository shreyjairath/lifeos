"""FastAPI server for the lifeos personal agent."""
import asyncio
import json
import os
import shutil
import threading
from pathlib import Path
from typing import Optional

import yaml
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from core.conversation_manager import handle_message
from agent_executor import confirmations
from agent_executor import cancellation
from core.events import bus
from core.memory import (
    clear_session, get_display_history, get_all_display_history, list_conversations,
    get_or_create_for_project, get_or_create_main, truncate_session,
)
from tools.projects import list_projects
from tools.files import read_knowledge, update_knowledge, ALLOWED_FILES

# Load config
_config_path = Path(__file__).parent / "config.yaml"
with open(_config_path) as f:
    CONFIG = yaml.safe_load(f)

# Lifeos project root (one level above agent/)
LIFEOS_ROOT = str(Path(__file__).parent.parent)


def _find_claude() -> str:
    """Resolve the claude CLI binary, checking PATH then common install locations."""
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
    return "claude"   # last resort — will surface a clear error at call time


CLAUDE_BIN = _find_claude()

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Connect to Chrome DevTools MCP in a background thread (non-blocking for startup)
    def _init_chrome():
        try:
            from tools.chrome_mcp import connect, get_tool_definitions
            from agent_executor.tools_registry import TOOLS
            if connect(timeout=60):
                defs = get_tool_definitions()
                TOOLS.extend(defs)
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning("Chrome MCP init failed: %s", exc)

    threading.Thread(target=_init_chrome, daemon=True).start()
    yield
    bus.shutdown()


app = FastAPI(title="lifeos agent", lifespan=lifespan)

# Serve static files
_static_dir = Path(__file__).parent.parent / "frontend"
app.mount("/static", StaticFiles(directory=str(_static_dir)), name="static")


@app.get("/")
async def index():
    return FileResponse(str(_static_dir / "index.html"))


# ── Chat ────────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    conv_id: str
    session_id: str
    message: str


@app.post("/api/chat")
async def chat(req: ChatRequest):
    return StreamingResponse(
        handle_message(req.conv_id, req.session_id, req.message, CONFIG),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/chat/{conv_id}")
async def get_all_chat_history(conv_id: str):
    return get_all_display_history(conv_id)


@app.get("/api/chat/{conv_id}/{session_id}")
async def get_chat_history(conv_id: str, session_id: str):
    display, total = get_display_history(conv_id, session_id)
    return {"conv_id": conv_id, "session_id": session_id, "messages": display, "total": total}


@app.delete("/api/chat/{conv_id}/{session_id}")
async def clear_chat(conv_id: str, session_id: str):
    clear_session(conv_id, session_id)
    return {"cleared": session_id}


class TruncateRequest(BaseModel):
    index: int


@app.post("/api/chat/{conv_id}/{session_id}/truncate")
async def truncate_chat(conv_id: str, session_id: str, body: TruncateRequest):
    remaining = truncate_session(conv_id, session_id, body.index)
    return {"session_id": session_id, "remaining": remaining}


# ── Conversations ─────────────────────────────────────────────────────────────

@app.get("/api/conversations")
async def get_conversations():
    return {"conversations": list_conversations()}


@app.post("/api/conversations/for-project")
async def conversation_for_project(body: dict):
    project_name = body.get("project_name", "")
    conv_id, session_id = get_or_create_for_project(project_name)
    return {"conv_id": conv_id, "session_id": session_id}


@app.get("/api/conversations/main")
async def get_main_conversation():
    conv_id, session_id = get_or_create_main()
    return {"conv_id": conv_id, "session_id": session_id}


# ── Projects ─────────────────────────────────────────────────────────────────

@app.get("/api/projects")
async def get_projects():
    return list_projects()


# ── Knowledge ────────────────────────────────────────────────────────────────

@app.get("/api/knowledge")
async def get_knowledge_index():
    return {"files": list(ALLOWED_FILES.keys())}


@app.get("/api/knowledge/{file_key}")
async def get_knowledge_file(file_key: str):
    result = read_knowledge(file_key)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


class KnowledgeUpdate(BaseModel):
    content: str


@app.put("/api/knowledge/{file_key}")
async def put_knowledge_file(file_key: str, body: KnowledgeUpdate):
    result = update_knowledge(file_key, body.content)
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


# ── Prompt parts ─────────────────────────────────────────────────────────────

_PROMPT_PARTS_DIR = Path(__file__).parent / "core" / "system_prompt_parts"


@app.get("/api/prompt-parts")
async def list_prompt_parts():
    parts = [p.name for p in sorted(_PROMPT_PARTS_DIR.glob("*.md"))]
    return {"parts": parts}


@app.get("/api/prompt-parts/{name}")
async def get_prompt_part(name: str):
    path = _PROMPT_PARTS_DIR / name
    if not path.exists() or path.suffix != ".md":
        raise HTTPException(status_code=404, detail=f"Prompt part '{name}' not found")
    return {"name": name, "content": path.read_text(encoding="utf-8")}


class PromptPartUpdate(BaseModel):
    content: str


@app.put("/api/prompt-parts/{name}")
async def put_prompt_part(name: str, body: PromptPartUpdate):
    path = _PROMPT_PARTS_DIR / name
    if not path.exists() or path.suffix != ".md":
        raise HTTPException(status_code=404, detail=f"Prompt part '{name}' not found")
    path.write_text(body.content, encoding="utf-8")
    bus.publish({"type": "prompt_part_updated", "name": name, "chars": len(body.content)})
    return {"updated": name}


# ── Events stream ────────────────────────────────────────────────────────────

async def _event_stream():
    async for event in bus.subscribe():
        yield f"data: {json.dumps(event)}\n\n"


@app.post("/api/chat/{conv_id}/{session_id}/stop")
async def stop_agent(conv_id: str, session_id: str):
    cancellation.cancel(session_id)
    return {"ok": True}


@app.post("/api/tool-confirm/{req_id}")
async def tool_confirm(req_id: str, body: dict):
    ok = confirmations.resolve(req_id, body.get("approved", False))
    if not ok:
        raise HTTPException(status_code=404, detail="Unknown confirmation request")
    return {"ok": True}


@app.get("/api/events")
async def events_stream():
    return StreamingResponse(
        _event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Claude Code Chat ──────────────────────────────────────────────────────────

_CC_HISTORY_FILE = Path(__file__).parent.parent / ".user-data" / "cc_history.json"
_cc_lock = threading.Lock()


def _load_cc_history() -> dict:
    if _CC_HISTORY_FILE.exists():
        try:
            return json.loads(_CC_HISTORY_FILE.read_text())
        except Exception:
            return {}
    return {}


def _save_cc_exchange(session_id: str, user_msg: str, cc_response: str) -> None:
    """Persist a complete user↔CC exchange to disk."""
    _CC_HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    with _cc_lock:
        history = _load_cc_history()
        history.setdefault(session_id, [])
        history[session_id].append({"role": "user",  "text": user_msg})
        history[session_id].append({"role": "cc",    "text": cc_response})
        _CC_HISTORY_FILE.write_text(json.dumps(history, indent=2))


class CCChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = None   # Claude Code session ID; None = new session


async def _stream_cc_chat(message: str, session_id: Optional[str] = None):
    """
    Stream a Claude Code response.
    - New session  : claude -p <msg> --output-format stream-json
    - Resume       : claude --resume <id> -p <msg> --output-format stream-json
    The session_id from the result event is forwarded to the frontend so it
    can pass it back on the next turn (Option B session management).
    """
    try:
        bus.publish({"type": "cc_request", "session_id": session_id, "message": message})

        cmd = [CLAUDE_BIN]
        if session_id:
            cmd += ["--resume", session_id]
        cmd += ["-p", message, "--output-format", "stream-json", "--verbose"]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=LIFEOS_ROOT,
        )

        got_output = False
        full_response = ""   # accumulate to persist after completion
        final_sid = session_id

        async for raw in proc.stdout:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            got_output = True
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                # Forward raw unparseable lines as debug text so we can see what's coming
                yield f"data: {json.dumps({'type': 'text', 'text': line + chr(10)})}\n\n"
                continue

            etype = event.get("type")
            if etype == "assistant":
                for block in event.get("message", {}).get("content", []):
                    if isinstance(block, dict):
                        if block.get("type") == "text":
                            full_response += block.get("text", "")
                        yield f"data: {json.dumps({'type': 'cc_block', 'block': block})}\n\n"
            elif etype == "result":
                final_sid = event.get("session_id", "") or final_sid
                if final_sid:
                    yield f"data: {json.dumps({'type': 'session_id', 'session_id': final_sid})}\n\n"
                bus.publish({"type": "cc_response", "session_id": final_sid, "chars": len(full_response)})
                yield f"data: {json.dumps({'type': 'done'})}\n\n"
            elif etype == "system":
                pass  # session info at startup — ignore

        await proc.wait()

        # Persist the exchange so history can be replayed on reload
        if final_sid and full_response:
            _save_cc_exchange(final_sid, message, full_response)

        # Surface stderr so errors are never silently swallowed
        stderr_bytes = await proc.stderr.read()
        stderr_text = stderr_bytes.decode("utf-8", errors="replace").strip()
        if stderr_text:
            yield f"data: {json.dumps({'type': 'error', 'text': stderr_text})}\n\n"
        elif not got_output:
            yield f"data: {json.dumps({'type': 'error', 'text': f'Claude Code produced no output (exit {proc.returncode}). Binary: {CLAUDE_BIN}'})}\n\n"

    except FileNotFoundError:
        yield f"data: {json.dumps({'type': 'error', 'text': f'claude CLI not found at {CLAUDE_BIN!r} — run `which claude` and check PATH'})}\n\n"
    except Exception as e:
        yield f"data: {json.dumps({'type': 'error', 'text': str(e)})}\n\n"


@app.get("/api/cc/history")
async def get_cc_history(session_id: str):
    history = _load_cc_history()
    return {"session_id": session_id, "messages": history.get(session_id, [])}


@app.post("/api/cc/chat")
async def cc_chat(req: CCChatRequest):
    return StreamingResponse(
        _stream_cc_chat(req.message, req.session_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
