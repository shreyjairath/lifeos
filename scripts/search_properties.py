"""
Realtor.com property search via RapidAPI
Usage: RAPIDAPI_KEY=your_key python search_properties.py
"""

import httpx
import json
import os
import sys

RAPIDAPI_KEY = os.environ.get("RAPIDAPI_KEY", "")

HEADERS = {
    "x-rapidapi-key": RAPIDAPI_KEY,
    "x-rapidapi-host": "realtor-com4.p.rapidapi.com",
}

BASE_URL = "https://realtor-com4.p.rapidapi.com"

SEARCHES = [
    {"location": "Evanston, IL",              "label": "Evanston"},
    {"location": "Lincoln Square, Chicago, IL", "label": "Lincoln Square"},
    {"location": "Andersonville, Chicago, IL",  "label": "Andersonville"},
]

PARAMS_BASE = {
    "price_min": 350000,
    "price_max": 750000,
    "beds_min":  2,
    "baths_min": 2,
    "sqft_min":  1400,
    "prop_type": "condo,townhome",   # realtor.com values: condo, townhome, single_family, multi_family
    "sort":      "relevance",
    "limit":     200,
    "offset":    0,
}


def fmt_price(v):
    if v is None:
        return "N/A"
    return f"${v:,.0f}"


def fmt_hoa(listing):
    """Extract HOA from various possible fields."""
    # Try hoa_fee at top level
    hoa = listing.get("hoa_fee")
    if hoa:
        return f"${hoa:,.0f}/mo"
    # Some endpoints nest under description
    desc = listing.get("description", {})
    hoa = desc.get("hoa_fee")
    if hoa:
        return f"${hoa:,.0f}/mo"
    return "N/A"


def search(location: str) -> list[dict]:
    params = {**PARAMS_BASE, "location": location}
    url = f"{BASE_URL}/properties/search-buy"

    all_results = []
    offset = 0
    page = 1

    while True:
        params["offset"] = offset
        print(f"  Fetching page {page} (offset={offset})…", file=sys.stderr)
        resp = httpx.get(url, headers=HEADERS, params=params, timeout=30)

        if resp.status_code == 401:
            print("\nERROR: Invalid or missing RapidAPI key.", file=sys.stderr)
            print("Set RAPIDAPI_KEY env variable and retry.", file=sys.stderr)
            sys.exit(1)

        resp.raise_for_status()
        data = resp.json()

        # Navigate the response shape — realtor-com4 uses data.home_search.results
        results = (
            data.get("data", {})
                .get("home_search", {})
                .get("results", [])
            or data.get("results", [])
            or data.get("data", [])
        )

        if not results:
            break

        all_results.extend(results)
        total = (
            data.get("data", {})
                .get("home_search", {})
                .get("total", len(results))
            or len(results)
        )

        offset += len(results)
        if offset >= total or len(results) < PARAMS_BASE["limit"]:
            break
        page += 1

    return all_results


def parse_listing(listing: dict) -> dict | None:
    """Normalise a raw listing dict into a clean record."""
    loc = listing.get("location", {})
    address_obj = loc.get("address", {}) or listing.get("location", {})
    if not address_obj:
        address_obj = listing.get("address", {})

    street    = address_obj.get("line", "") or address_obj.get("street", "")
    city      = address_obj.get("city", "")
    state     = address_obj.get("state_code", "") or address_obj.get("state", "")
    zip_code  = address_obj.get("postal_code", "")
    address   = f"{street}, {city}, {state} {zip_code}".strip(", ")

    desc = listing.get("description", {})
    price   = listing.get("list_price") or desc.get("list_price")
    beds    = desc.get("beds") or listing.get("beds")
    baths   = desc.get("baths_consolidated") or desc.get("baths") or listing.get("baths")
    sqft    = desc.get("sqft") or listing.get("sqft")
    prop_id = listing.get("property_id", "") or listing.get("listing_id", "")
    slug    = listing.get("permalink", "")

    url = f"https://www.realtor.com/realestateandhomes-detail/{slug}" if slug else (
          f"https://www.realtor.com/realestateandhomes-detail/{prop_id}" if prop_id else "N/A")

    hoa = fmt_hoa(listing)

    if not address.strip(",").strip():
        return None

    return {
        "address": address,
        "price":   fmt_price(price),
        "beds":    beds or "N/A",
        "baths":   baths or "N/A",
        "sqft":    f"{sqft:,}" if isinstance(sqft, (int, float)) else (sqft or "N/A"),
        "hoa":     hoa,
        "url":     url,
    }


def print_results(label: str, listings: list[dict]):
    print(f"\n{'='*70}")
    print(f"  {label}  ({len(listings)} listings)")
    print(f"{'='*70}")
    if not listings:
        print("  No results found.")
        return
    for i, p in enumerate(listings, 1):
        print(f"\n[{i}] {p['address']}")
        print(f"    Price : {p['price']}")
        print(f"    Beds  : {p['beds']}  |  Baths: {p['baths']}  |  Sqft: {p['sqft']}")
        print(f"    HOA   : {p['hoa']}")
        print(f"    URL   : {p['url']}")


def main():
    if not RAPIDAPI_KEY:
        print_template()
        return

    all_properties = {}
    for s in SEARCHES:
        print(f"\nSearching {s['label']}…", file=sys.stderr)
        try:
            raw = search(s["location"])
            parsed = [p for r in raw if (p := parse_listing(r))]
            all_properties[s["label"]] = parsed
        except httpx.HTTPStatusError as e:
            print(f"  HTTP error for {s['label']}: {e}", file=sys.stderr)
            all_properties[s["label"]] = []

    for label, listings in all_properties.items():
        print_results(label, listings)

    # Summary
    total = sum(len(v) for v in all_properties.values())
    print(f"\n{'='*70}")
    print(f"TOTAL: {total} properties across all neighborhoods")
    print(f"Filters: $350k–$750k | 2+ bed | 2+ bath | 1400+ sqft | condo/townhouse")


def print_template():
    """Show what the API call looks like when no key is provided."""
    print("""
No RAPIDAPI_KEY found in environment.

API call template:
─────────────────────────────────────────────────────────────
GET https://realtor-com4.p.rapidapi.com/properties/search-buy

Headers:
  x-rapidapi-key:  <YOUR_KEY>
  x-rapidapi-host: realtor-com4.p.rapidapi.com

Query params (example for Evanston):
  location  = Evanston, IL
  price_min = 350000
  price_max = 750000
  beds_min  = 2
  baths_min = 2
  sqft_min  = 1400
  prop_type = condo,townhome
  sort      = relevance
  limit     = 200
  offset    = 0
─────────────────────────────────────────────────────────────

To run:
  RAPIDAPI_KEY=your_key_here python scripts/search_properties.py

Or export once:
  export RAPIDAPI_KEY=your_key_here
  python scripts/search_properties.py
""")


if __name__ == "__main__":
    main()
