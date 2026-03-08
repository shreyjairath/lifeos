"""Fetch and extract readable content from JS-rendered / SPA pages via Playwright.

Applies stealth patches (playwright-stealth) + browser-level args to bypass
bot detection on sites like Redfin, Zillow, and Realtor.com.
"""
import asyncio
import random
from concurrent.futures import ThreadPoolExecutor

import trafilatura

MAX_CHARS = 50_000  # ~12k tokens

# Common desktop resolutions — randomised per request to avoid fingerprinting
_VIEWPORTS = [
    {"width": 1920, "height": 1080},
    {"width": 1440, "height": 900},
    {"width": 1536, "height": 864},
    {"width": 1280, "height": 800},
    {"width": 1366, "height": 768},
]

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)


async def _fetch_rendered(url: str) -> tuple:
    """Run inside a fresh event loop (worker thread). Returns (final_url, title, html)."""
    try:
        from playwright.async_api import async_playwright, TimeoutError as PWTimeout
    except ImportError:
        raise RuntimeError(
            "Playwright not installed. Run: pip install playwright && playwright install chromium"
        )
    try:
        from playwright_stealth import Stealth
    except ImportError:
        raise RuntimeError(
            "playwright-stealth not installed. Run: pip install playwright-stealth"
        )

    viewport = random.choice(_VIEWPORTS)

    stealth = Stealth(
        navigator_user_agent_override=_USER_AGENT,
        navigator_platform_override="Win32",
        navigator_vendor_override="Google Inc.",
        webgl_vendor_override="Intel Inc.",
        webgl_renderer_override="Intel Iris OpenGL Engine",
    )

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-infobars",
                "--disable-extensions",
                f"--window-size={viewport['width']},{viewport['height']}",
            ],
        )
        context = await browser.new_context(
            viewport=viewport,
            user_agent=_USER_AGENT,
            locale="en-US",
            timezone_id="America/Chicago",
            extra_http_headers={
                "Accept-Language": "en-US,en;q=0.9",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"Windows"',
            },
        )
        await stealth.apply_stealth_async(context)
        page = await context.new_page()
        await page.goto(url, timeout=30_000, wait_until="domcontentloaded")
        try:
            await page.wait_for_load_state("networkidle", timeout=10_000)
        except PWTimeout:
            pass  # proceed with whatever has loaded so far
        final_url = page.url
        title = await page.title()
        html = await page.content()
        await browser.close()
        return final_url, title, html


def browse_page_js(url: str) -> dict:
    if not url.startswith(("http://", "https://")):
        return {"error": "Only http/https URLs are supported.", "url": url}

    # Run async Playwright in a worker thread with its own event loop,
    # avoiding conflicts with FastAPI's running loop.
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(asyncio.run, _fetch_rendered(url))
            final_url, title, html = future.result(timeout=60)
    except Exception as e:
        return {"error": str(e), "url": url}

    text = trafilatura.extract(html, include_comments=False, include_tables=True, favor_recall=True)

    if not text or len(text) < 200:
        return {"error": "Could not extract readable content after JS rendering.", "url": final_url, "title": title}

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
