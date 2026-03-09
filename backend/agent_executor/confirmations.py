"""Async tool confirmation mechanism.

When the agent wants to call a gated tool, it registers a pending confirmation
and yields a tool_confirm_request SSE event. The frontend shows an approve/deny
prompt; the user's response arrives via POST /api/tool-confirm/{req_id} and
resolves the waiting coroutine.
"""
import asyncio
import uuid

# Tools that require explicit user approval before execution
GATED_TOOLS: set[str] = {"run_python", "claude_code"}
GATED_PREFIXES: tuple[str, ...] = ("chrome_",)

_pending: dict[str, asyncio.Event] = {}
_results: dict[str, bool] = {}

CONFIRMATION_TIMEOUT_S = 120  # 2 minutes


def is_gated(tool_name: str) -> bool:
    if tool_name in GATED_TOOLS:
        return True
    return any(tool_name.startswith(p) for p in GATED_PREFIXES)


def register() -> str:
    """Create a pending confirmation slot. Returns a unique request id."""
    req_id = uuid.uuid4().hex[:10]
    _pending[req_id] = asyncio.Event()
    return req_id


async def wait_for(req_id: str) -> bool:
    """Block until the user resolves the confirmation. Returns True if approved."""
    event = _pending.get(req_id)
    if event is None:
        return False
    try:
        await asyncio.wait_for(event.wait(), timeout=CONFIRMATION_TIMEOUT_S)
    except asyncio.TimeoutError:
        pass
    approved = _results.pop(req_id, False)
    _pending.pop(req_id, None)
    return approved


def resolve(req_id: str, approved: bool) -> bool:
    """Called by the API endpoint when the user responds. Returns False if unknown req_id."""
    if req_id not in _pending:
        return False
    _results[req_id] = approved
    _pending[req_id].set()
    return True
