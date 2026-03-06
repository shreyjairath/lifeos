"""Web search via DuckDuckGo HTML endpoint."""
import re
import httpx


def web_search(query: str, max_results: int = 5) -> dict:
    """Search DuckDuckGo and return top results."""
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
    }
    try:
        resp = httpx.get(
            "https://html.duckduckgo.com/html/",
            params={"q": query},
            headers=headers,
            timeout=10,
            follow_redirects=True,
        )
        resp.raise_for_status()
    except Exception as e:
        return {"error": str(e), "results": []}

    # Extract results from HTML without a full parser
    results = []
    # Find result links and snippets
    link_pattern = re.compile(
        r'class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', re.DOTALL
    )
    snippet_pattern = re.compile(
        r'class="result__snippet"[^>]*>(.*?)</[a-z]+>', re.DOTALL
    )

    links = link_pattern.findall(resp.text)
    snippets = [re.sub(r"<[^>]+>", "", s).strip() for s in snippet_pattern.findall(resp.text)]

    for i, (url, title) in enumerate(links[:max_results]):
        title_clean = re.sub(r"<[^>]+>", "", title).strip()
        snippet = snippets[i] if i < len(snippets) else ""
        results.append({"title": title_clean, "url": url, "snippet": snippet})

    return {"query": query, "results": results}
