"""Parse Redfin listing and search/neighborhood pages into structured JSON."""
import json
import re

import httpx

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}


def _parse_int(s: str) -> int | None:
    if not s:
        return None
    cleaned = re.sub(r"[^\d]", "", s)
    return int(cleaned) if cleaned else None


def _extract_json_ld(html: str) -> dict:
    scripts = re.findall(
        r'<script type="application/ld\+json">(.*?)</script>', html, re.DOTALL
    )
    for s in scripts:
        try:
            d = json.loads(s)
            types = d.get("@type", [])
            if isinstance(types, str):
                types = [types]
            if "RealEstateListing" in types or "Product" in types:
                return d
        except (json.JSONDecodeError, AttributeError):
            pass
    return {}


def parse_redfin_listing(url: str) -> dict:
    if not url.startswith(("http://", "https://")):
        return {"error": "URL must start with http:// or https://"}
    if "redfin.com" not in url:
        return {"error": "URL must be a redfin.com listing"}

    try:
        r = httpx.get(url, headers=_HEADERS, follow_redirects=True, timeout=15)
        r.raise_for_status()
    except httpx.HTTPError as e:
        return {"error": f"Failed to fetch listing: {e}"}

    html = r.text
    ld = _extract_json_ld(html)
    entity = ld.get("mainEntity", {})
    addr = entity.get("address", {})
    geo = entity.get("geo", {})
    offers = ld.get("offers", {})

    # Core fields from JSON-LD
    price = offers.get("price")
    sq_ft = entity.get("floorSize", {}).get("value")
    beds = entity.get("numberOfBedrooms")
    baths = entity.get("numberOfBathroomsTotal")
    year_built = entity.get("yearBuilt")
    property_type = entity.get("accommodationCategory") or entity.get("@type")
    description = ld.get("description", "").strip()
    date_listed = (ld.get("datePosted") or "")[:10] or None

    amenities = [
        f["name"]
        for f in entity.get("amenityFeature", [])
        if isinstance(f, dict) and f.get("value") is True
    ]

    images = [
        img["url"]
        for img in entity.get("image", [])
        if isinstance(img, dict) and img.get("url")
    ]

    # Supplementary fields from raw HTML
    hoa_match = re.search(r'(\$[\d,]+)/mo</span><span[^>]*>HOA Dues', html)
    hoa_monthly = _parse_int(hoa_match.group(1)) if hoa_match else None

    mls_match = re.search(r'MLS#\s*([A-Z0-9]+)', html)
    mls_number = mls_match.group(1) if mls_match else None

    dom_match = re.search(r'(\d+)\s*[Dd]ays?\s*on\s*[Mm]arket', html)
    days_on_market = int(dom_match.group(1)) if dom_match else None

    tax_match = re.search(r'[Aa]nnual [Tt]ax[^"]*","content":"(\$[\d,]+)', html)
    taxes_annual = _parse_int(tax_match.group(1)) if tax_match else None

    price_per_sqft = round(price / sq_ft) if price and sq_ft else None

    return {
        "url": url,
        "mls_number": mls_number,
        "date_listed": date_listed,
        "days_on_market": days_on_market,
        "address": {
            "street": addr.get("streetAddress"),
            "city": addr.get("addressLocality"),
            "state": addr.get("addressRegion"),
            "zip": addr.get("postalCode"),
        },
        "lat": geo.get("latitude"),
        "lon": geo.get("longitude"),
        "price": price,
        "price_per_sqft": price_per_sqft,
        "beds": beds,
        "baths": baths,
        "sq_ft": sq_ft,
        "year_built": year_built,
        "property_type": property_type,
        "hoa_monthly": hoa_monthly,
        "taxes_annual": taxes_annual,
        "amenities": amenities,
        "description": description,
        "images": images,
    }


def parse_redfin_search(url: str) -> dict:
    """Parse a Redfin search/neighborhood/filter results page.

    Returns a list of listings with price, beds, baths, sq_ft, and URL.
    Works by combining positionally-aligned JSON-LD blocks, card prices,
    and card aria-labels (all 3 appear in the same order in the static HTML).
    """
    if not url.startswith(("http://", "https://")):
        return {"error": "URL must start with http:// or https://"}
    if "redfin.com" not in url:
        return {"error": "URL must be a redfin.com URL"}

    try:
        r = httpx.get(url, headers=_HEADERS, follow_redirects=True, timeout=15)
        r.raise_for_status()
    except httpx.HTTPError as e:
        return {"error": f"Failed to fetch page: {e}"}

    html = r.text

    # --- JSON-LD listing blocks (url, address, geo, sq_ft, property_type) ---
    scripts = re.findall(
        r'<script type="application/ld\+json">(.*?)</script>', html, re.DOTALL
    )
    ld_listings = []
    for s in scripts:
        try:
            d = json.loads(s)
            if isinstance(d, list) and d and "redfin.com" in d[0].get("url", ""):
                ld_listings.append(d[0])
        except (json.JSONDecodeError, AttributeError):
            pass

    # --- Prices from card elements ---
    prices_raw = re.findall(r'bp-Homecard__Price--value">(\$[\d,]+)', html)

    # --- Beds/baths from card aria-labels ---
    aria_labels = re.findall(
        r'aria-label="Property at ([^"]+, \d+ beds?, [^"]+)"', html
    )

    # Build listings by zipping all three (same order in HTML)
    n = min(len(ld_listings), len(prices_raw), len(aria_labels))
    listings = []
    for i in range(n):
        ld = ld_listings[i]
        addr = ld.get("address", {})
        geo = ld.get("geo", {})

        price = _parse_int(prices_raw[i])
        sq_ft = ld.get("floorSize", {}).get("value")
        price_per_sqft = round(price / sq_ft) if price and sq_ft else None

        # Parse "2352 W Wilson Ave Unit 2E, Chicago, IL 60625, 2 beds, 2 baths"
        beds = baths = None
        m = re.search(r"(\d+) beds?", aria_labels[i])
        if m:
            beds = int(m.group(1))
        m = re.search(r"(\d+(?:\.\d+)?) baths?", aria_labels[i])
        if m:
            baths = float(m.group(1))
            if baths == int(baths):
                baths = int(baths)

        listings.append({
            "url": ld.get("url"),
            "address": {
                "street": addr.get("streetAddress"),
                "city": addr.get("addressLocality"),
                "state": addr.get("addressRegion"),
                "zip": addr.get("postalCode"),
            },
            "lat": geo.get("latitude"),
            "lon": geo.get("longitude"),
            "price": price,
            "price_per_sqft": price_per_sqft,
            "beds": beds,
            "baths": baths,
            "sq_ft": sq_ft,
            "property_type": ld.get("@type"),
        })

    return {
        "url": url,
        "count": len(listings),
        "listings": listings,
    }
