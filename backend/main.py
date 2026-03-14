"""FastAPI server for the lifeos personal agent."""
import asyncio
import json
import re
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
    clear_session, get_display_history, list_sessions,
    get_or_create_for_project, create_new_session, truncate_session,
)
from core.knowledge import (
    load_active_instructions, save_active_instructions, load_prompt_part,
    list_prompt_parts,
)
from tools.projects import list_projects as _list_projects
from agent_executor.tools_registry import all_tool_names, load_disabled_tools, save_disabled_tools

# Load config
_config_path = Path(__file__).parent / "config.yaml"
with open(_config_path) as f:
    CONFIG = yaml.safe_load(f)

LIFEOS_ROOT = str(Path(__file__).parent.parent)

_SAFE_NAME = re.compile(r"^[a-zA-Z0-9._-]+\.md$")
_USER_DATA = Path(__file__).parent.parent / ".user-data"
_PROMPT_PARTS_FS = _USER_DATA / "prompt-parts"


def _find_claude() -> str:
    found = shutil.which("claude")
    if found:
        return found
    for c in [
        Path.home() / ".local" / "bin" / "claude",
        Path.home() / ".npm-global" / "bin" / "claude",
        Path("/usr/local/bin/claude"),
        Path("/opt/homebrew/bin/claude"),
    ]:
        if c.exists():
            return str(c)
    return "claude"


CLAUDE_BIN = _find_claude()


@asynccontextmanager
async def lifespan(app: FastAPI):
    def _init_chrome():
        try:
            from tools.chrome_mcp import connect, get_tool_definitions
            from agent_executor.tools_registry import TOOLS
            if connect(timeout=60):
                TOOLS.extend(get_tool_definitions())
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning("Chrome MCP init failed: %s", exc)

    threading.Thread(target=_init_chrome, daemon=True).start()
    yield
    bus.shutdown()


app = FastAPI(title="lifeos agent", lifespan=lifespan)

# Static files — serve frontend
_static_dir = Path(__file__).parent.parent / "frontend"


@app.get("/")
async def index():
    return FileResponse(str(_static_dir / "index.html"))


@app.get("/app.js")
async def app_js():
    return FileResponse(str(_static_dir / "app.js"), media_type="application/javascript")


@app.get("/styles.css")
async def styles_css():
    return FileResponse(str(_static_dir / "styles.css"), media_type="text/css")


@app.get("/modules/{filename:path}")
async def module_file(filename: str):
    p = _static_dir / "modules" / filename
    if not p.exists():
        raise HTTPException(status_code=404)
    return FileResponse(str(p), media_type="application/javascript")


# ── Chat ─────────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    session_id: str
    message: str


@app.post("/api/chat")
async def chat(req: ChatRequest):
    return StreamingResponse(
        handle_message(req.session_id, req.message, CONFIG),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/chat/{session_id}")
async def get_chat_history(session_id: str):
    return get_display_history(session_id)


@app.delete("/api/chat/{session_id}")
async def clear_chat(session_id: str):
    clear_session(session_id)
    return {"cleared": session_id}


class TruncateRequest(BaseModel):
    index: int


@app.post("/api/chat/{session_id}/truncate")
async def truncate_chat(session_id: str, body: TruncateRequest):
    remaining = truncate_session(session_id, body.index)
    return {"session_id": session_id, "remaining": remaining}


@app.post("/api/chat/{session_id}/stop")
async def stop_agent(session_id: str):
    cancellation.cancel(session_id)
    return {"ok": True}


@app.post("/api/tool-confirm/{req_id}")
async def tool_confirm(req_id: str, body: dict):
    ok = confirmations.resolve(req_id, body.get("approved", False))
    if not ok:
        raise HTTPException(status_code=404, detail="Unknown confirmation request")
    return {"ok": True}


# ── Sessions ─────────────────────────────────────────────────────────────────

@app.get("/api/sessions")
async def get_sessions():
    return {"sessions": list_sessions()}


@app.post("/api/sessions")
async def create_session():
    return {"session_id": create_new_session()}


@app.post("/api/sessions/for-project")
async def session_for_project(body: dict):
    project_name = body.get("project_name", "")
    return {"session_id": get_or_create_for_project(project_name)}


# ── Projects ─────────────────────────────────────────────────────────────────

@app.get("/api/projects")
async def get_projects():
    return _list_projects()


# ── Knowledge (notes) ─────────────────────────────────────────────────────────

@app.get("/api/knowledge")
async def get_knowledge_index():
    from tools.knowledge_files import list_notes
    return list_notes()


@app.get("/api/knowledge/{filename}")
async def get_knowledge_file(filename: str):
    from tools.knowledge_files import read_note
    result = read_note(filename)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


class KnowledgeUpdate(BaseModel):
    content: str


@app.put("/api/knowledge/{filename}")
async def put_knowledge_file(filename: str, body: KnowledgeUpdate):
    from tools.knowledge_files import write_note
    result = write_note(filename, body.content)
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


# ── Prompt parts ──────────────────────────────────────────────────────────────

@app.get("/api/prompt-parts")
async def get_prompt_parts_list():
    return {"parts": list_prompt_parts()}


@app.get("/api/prompt-parts/{name}")
async def get_prompt_part(name: str):
    if not _SAFE_NAME.match(name):
        raise HTTPException(status_code=400, detail="Invalid filename")
    content = load_prompt_part(name)
    if not content:
        raise HTTPException(status_code=404, detail=f"Prompt part '{name}' not found")
    return {"name": name, "content": content}


class PromptPartUpdate(BaseModel):
    content: str


@app.put("/api/prompt-parts/{name}")
async def put_prompt_part(name: str, body: PromptPartUpdate):
    if not _SAFE_NAME.match(name):
        raise HTTPException(status_code=400, detail="Invalid filename")
    _PROMPT_PARTS_FS.mkdir(parents=True, exist_ok=True)
    (_PROMPT_PARTS_FS / name).write_text(body.content, encoding="utf-8")
    bus.publish({"type": "prompt_part_updated", "name": name, "chars": len(body.content)})
    return {"updated": name}


@app.get("/api/active-instructions")
async def get_active_instructions():
    return {"name": load_active_instructions()}


@app.put("/api/active-instructions")
async def put_active_instructions(body: dict):
    name = body.get("name", "")
    if not _SAFE_NAME.match(name):
        raise HTTPException(status_code=400, detail="Invalid filename")
    save_active_instructions(name)
    return {"active": name}


# ── Tools ─────────────────────────────────────────────────────────────────────

@app.get("/api/tools")
async def get_tools_list():
    return {"tools": all_tool_names(), "disabled": sorted(load_disabled_tools())}


class DisabledToolsUpdate(BaseModel):
    disabled: list[str]


@app.put("/api/tools/disabled")
async def put_disabled_tools(body: DisabledToolsUpdate):
    save_disabled_tools(set(body.disabled))
    return {"disabled": sorted(body.disabled)}


# ── Events stream ─────────────────────────────────────────────────────────────

async def _event_stream():
    async for event in bus.subscribe():
        yield f"data: {json.dumps(event)}\n\n"


@app.get("/api/events")
async def events_stream():
    return StreamingResponse(
        _event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Claude Code sidecar ───────────────────────────────────────────────────────

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
    _CC_HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    with _cc_lock:
        history = _load_cc_history()
        history.setdefault(session_id, [])
        history[session_id].append({"role": "user", "text": user_msg})
        history[session_id].append({"role": "cc", "text": cc_response})
        _CC_HISTORY_FILE.write_text(json.dumps(history, indent=2))


class CCChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = None


async def _stream_cc_chat(message: str, session_id: Optional[str] = None):
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
        full_response = ""
        final_sid = session_id

        async for raw in proc.stdout:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            got_output = True
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
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

        await proc.wait()
        if final_sid and full_response:
            _save_cc_exchange(final_sid, message, full_response)

        stderr_bytes = await proc.stderr.read()
        stderr_text = stderr_bytes.decode("utf-8", errors="replace").strip()
        if stderr_text:
            yield f"data: {json.dumps({'type': 'error', 'text': stderr_text})}\n\n"
        elif not got_output:
            yield f"data: {json.dumps({'type': 'error', 'text': f'Claude Code produced no output (exit {proc.returncode})'})}\n\n"

    except FileNotFoundError:
        yield f"data: {json.dumps({'type': 'error', 'text': f'claude CLI not found at {CLAUDE_BIN!r}'})}\n\n"
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
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
