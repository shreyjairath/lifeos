"""Media display tools — signal the frontend to render media inline."""


def show_image(url: str, caption: str = "") -> dict:
    """Return a structured result that the frontend renders as an inline image."""
    if not url.startswith(("http://", "https://")):
        return {"error": "URL must start with http:// or https://"}
    return {"ok": True, "url": url, "caption": caption}
