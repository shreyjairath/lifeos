"""Hook registry and dispatcher.

Loads hooks.py from the agent directory and calls registered async functions
at lifecycle events. Hook errors are caught and logged — they never crash the agent.
"""
import asyncio
import importlib.util
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_hooks_module = None


def _load():
    global _hooks_module
    path = Path(__file__).parent.parent / "hooks.py"
    if not path.exists():
        return
    spec = importlib.util.spec_from_file_location("hooks", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    _hooks_module = mod


_load()


async def fire(name: str, **kwargs) -> any:
    """Call hooks.<name>(**kwargs) if it exists. Returns the hook's return value or None."""
    if _hooks_module is None:
        return None
    fn = getattr(_hooks_module, name, None)
    if fn is None:
        return None
    try:
        result = fn(**kwargs)
        if asyncio.iscoroutine(result):
            result = await result
        return result
    except Exception as e:
        logger.warning("Hook %s raised: %s", name, e)
        return None
