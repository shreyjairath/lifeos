"""Global event bus — publish backend events to all connected SSE clients."""
import asyncio
from collections.abc import AsyncGenerator
from typing import Any

_HISTORY_LIMIT = 500


class EventBus:
    def __init__(self):
        self._subscribers: list[asyncio.Queue] = []
        self._history: list[dict] = []
        self._shutdown = False

    def publish(self, event: dict[str, Any]) -> None:
        self._history.append(event)
        if len(self._history) > _HISTORY_LIMIT:
            self._history = self._history[-_HISTORY_LIMIT:]
        for q in self._subscribers:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass

    def shutdown(self) -> None:
        self._shutdown = True
        for q in self._subscribers:
            try:
                q.put_nowait(None)  # sentinel to unblock q.get()
            except asyncio.QueueFull:
                pass

    async def subscribe(self) -> AsyncGenerator[dict, None]:
        q: asyncio.Queue = asyncio.Queue(maxsize=512)
        self._subscribers.append(q)
        try:
            while True:
                event = await q.get()
                if event is None:
                    break
                yield event
        finally:
            if q in self._subscribers:
                self._subscribers.remove(q)


bus = EventBus()
