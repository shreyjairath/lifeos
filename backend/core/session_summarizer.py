"""SessionSummarizer: archives a session as a summary.md at rotation."""
import json

from agent_executor.llm_client import LlmClientResult, stream_llm
from core.knowledge import load_prompt_part
from core.memory import write_session_summary

_HAIKU_MODEL = "claude-haiku-4-5-20251001"


async def run(session_id: str, history: list) -> None:
    """Summarize the session and write summary.md for the given session_id."""
    transcript = _build_transcript(history)
    if not transcript:
        return

    prompt = load_prompt_part("summarize-session.md")
    if not prompt:
        prompt = (
            "Summarize this conversation session in 2-3 concise paragraphs for archival purposes. "
            "Focus on: what was discussed, decisions made, open threads. Write in second person "
            "(\"You were discussing...\", \"The user asked...\"). Be specific — include names, numbers, "
            "and concrete details. Omit small talk."
        )

    try:
        result = LlmClientResult()
        async for _ in stream_llm(
            _HAIKU_MODEL, prompt,
            [{"role": "user", "content": transcript}],
            tools=[], result=result, max_tokens=1024,
        ):
            pass
        if result.full_text:
            write_session_summary(session_id, result.full_text)
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning("Session summarizer failed: %s", e)


def _build_transcript(history: list) -> str:
    lines = []
    for msg in history:
        role = msg.get("role", "")
        content = msg.get("content", "")
        if isinstance(content, str):
            lines.append(f"{role.upper()}: {content}")
        elif isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "text":
                    lines.append(f"{role.upper()}: {block['text']}")
                elif btype == "tool_use":
                    lines.append(f"TOOL CALL [{block['name']}]: {json.dumps(block.get('input', {}))}")
                elif btype == "tool_result":
                    lines.append(f"TOOL RESULT: {block.get('content', '')}")
    return "\n\n".join(lines)
