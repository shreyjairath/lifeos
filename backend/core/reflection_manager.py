"""ReflectionManager: orchestrates notes, projects, and session summarization at rotation."""
from core import hooks
from core import notes_reflector, session_summarizer


async def run(
    session_id: str,
    history: list,
    pending_user_message: str = "",
    config: dict = None,
) -> str | None:
    """Run all reflection agents for the given session.

    Returns combined human-readable summary of what was persisted, or None.
    """
    if not history:
        return None

    # Append pending message to history view for summarizer context
    summarizer_history = list(history)
    if pending_user_message:
        summarizer_history.append({
            "role": "user",
            "content": f"(pending — triggered session rotation): {pending_user_message}",
        })

    notes_summary = await notes_reflector.run(history)

    projects_summary = None
    if config and config.get("reflect", {}).get("projects_enabled", False):
        from core import projects_reflector
        projects_summary = await projects_reflector.run(history)

    await session_summarizer.run(session_id, summarizer_history)

    parts = [p for p in [notes_summary, projects_summary] if p]
    result = "\n".join(parts) if parts else None

    await hooks.fire("on_reflection_done", session_id=session_id)
    return result
