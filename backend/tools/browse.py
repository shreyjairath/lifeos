"""Fetch and extract readable content from a web page."""
import httpx
import trafilatura

MAX_BYTES = 5_000_000   # 5MB read cap
MAX_CHARS = 50_000      # ~12k tokens


def browse_page(url: str) -> dict:
    # Scheme validation
    if not url.startswith(("http://", "https://")):
        return {"error": "Only http/https URLs are supported.", "url": url}

    headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}

    try:
        with httpx.stream("GET", url, headers=headers, timeout=15, follow_redirects=True) as resp:
            resp.raise_for_status()
            content_type = resp.headers.get("content-type", "")
            if "text/html" not in content_type:
                return {"error": f"Non-HTML content type: {content_type}", "url": str(resp.url)}

            chunks = []
            total = 0
            for chunk in resp.iter_bytes(chunk_size=65536):
                chunks.append(chunk)
                total += len(chunk)
                if total >= MAX_BYTES:
                    break
            html = b"".join(chunks).decode("utf-8", errors="replace")
            final_url = str(resp.url)
    except httpx.TimeoutException:
        return {"error": "Request timed out after 15s.", "url": url}
    except httpx.HTTPStatusError as e:
        return {"error": f"HTTP {e.response.status_code}", "url": url}
    except httpx.RequestError as e:
        return {"error": str(e), "url": url}

    # Extract main content
    meta = trafilatura.extract_metadata(html)
    title = meta.title if meta else ""
    text = trafilatura.extract(html, include_comments=False, include_tables=True, favor_recall=True)

    if not text or len(text) < 200:
        return {"error": "Could not extract readable content (page may be JS-rendered or paywalled).", "url": final_url, "title": title}

    word_count = len(text.split())
    truncated = len(text) > MAX_CHARS
    if truncated:
        text = text[:MAX_CHARS]

    return {
        "url": final_url,
        "title": title or "",
        "content": text,
        "truncated": truncated,
        "word_count": word_count,
    }
