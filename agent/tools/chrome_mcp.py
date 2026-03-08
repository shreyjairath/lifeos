"""Chrome DevTools MCP integration.

Spawns chrome-devtools-mcp via npx and maintains a persistent MCP session
in a background thread's event loop. Exposes a sync API so dispatch_tool
can call Chrome tools without restructuring the agent loop.

Connection strategy (tried in order):
  1. Attach to your running Chrome via localhost:9222 (real browser, real cookies)
     → launch Chrome with: --remote-debugging-port=9222
  2. Fall back to a headless Chromium instance
"""
import asyncio
import contextlib
import logging
import threading

logger = logging.getLogger(__name__)

# Module-level state
_loop = None  # asyncio.AbstractEventLoop
_session = None          # mcp.ClientSession, set after connect()
_exit_stack = None       # AsyncExitStack keeping context managers alive
_chrome_tools: list = [] # raw mcp.Tool objects
_ready = threading.Event()
_connect_error: Exception | None = None


# ---------------------------------------------------------------------------
# Internal async setup
# ---------------------------------------------------------------------------

async def _try_args(args: list) -> tuple:
    """Attempt to open an MCP session with the given npx args.
    Returns (session, tools, exit_stack) or raises on failure.
    """
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    server_params = StdioServerParameters(command="npx", args=args)
    stack = contextlib.AsyncExitStack()
    read, write = await stack.enter_async_context(stdio_client(server_params))
    session = await stack.enter_async_context(ClientSession(read, write))
    await session.initialize()
    result = await session.list_tools()
    return session, result.tools, stack


async def _open_session():
    global _session, _chrome_tools, _exit_stack, _connect_error
    try:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        # 1. Try attaching to a running Chrome with --remote-debugging-port=9222
        try:
            session, tools, stack = await asyncio.wait_for(
                _try_args(["--yes", "chrome-devtools-mcp@latest", "--browserUrl=http://localhost:9222"]),
                timeout=10,
            )
            mode = "real Chrome (localhost:9222)"
        except Exception:
            # 2. Fall back to headless
            session, tools, stack = await _try_args(
                ["--yes", "chrome-devtools-mcp@latest", "--headless"]
            )
            mode = "headless Chromium"

        _session = session
        _chrome_tools = tools
        _exit_stack = stack  # held at module level to prevent GC / context close
        logger.info("Chrome MCP connected via %s — %d tools available", mode, len(tools))
    except Exception as exc:
        _connect_error = exc
        logger.warning("Chrome MCP unavailable: %s", exc)
    finally:
        _ready.set()


def _run_loop(loop: asyncio.AbstractEventLoop):
    asyncio.set_event_loop(loop)
    loop.run_forever()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def connect(timeout: float = 60.0) -> bool:
    """Spawn the MCP server and connect. Returns True on success.

    Safe to call multiple times — no-op if already connected.
    """
    global _loop
    if _ready.is_set():
        return _session is not None

    _loop = asyncio.new_event_loop()
    thread = threading.Thread(target=_run_loop, args=(_loop,), daemon=True)
    thread.start()
    asyncio.run_coroutine_threadsafe(_open_session(), _loop)
    _ready.wait(timeout=timeout)
    return _session is not None


def get_tool_definitions():
    """Return Chrome tools in Anthropic tool-definition format, prefixed chrome_."""
    return [
        {
            "name": f"chrome_{tool.name}",
            "description": (tool.description or "").strip(),
            "input_schema": tool.inputSchema,
        }
        for tool in _chrome_tools
    ]


def call_tool(name: str, tool_input: dict) -> dict:
    """Synchronously call a Chrome MCP tool. name is the unprefixed MCP tool name."""
    if _session is None:
        return {"error": "Chrome MCP is not connected"}
    if _loop is None:
        return {"error": "Chrome MCP event loop not running"}

    async def _call():
        return await _session.call_tool(name, tool_input)

    try:
        result = asyncio.run_coroutine_threadsafe(_call(), _loop).result(timeout=30)
    except Exception as exc:
        return {"error": str(exc)}

    # Convert MCP content blocks → plain dict
    texts = [c.text for c in result.content if hasattr(c, "text")]
    return {
        "output": "\n".join(texts),
        "is_error": bool(result.isError),
    }
