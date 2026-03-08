#!/usr/bin/env python3
"""Sweep Chicago neighborhoods for condos under $700k via Redfin Stingray API."""

import json
import re
import time
import requests
from pathlib import Path

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Referer": "https://www.redfin.com/",
}

NEIGHBORHOODS = {
    "Evanston":      dict(lat1=42.019, lat2=42.072, lng1=-87.720, lng2=-87.664),
    "Lincoln Square": dict(lat1=41.963, lat2=41.981, lng1=-87.724, lng2=-87.690),
    "Ravenswood":    dict(lat1=41.951, lat2=41.968, lng1=-87.716, lng2=-87.686),
    "Andersonville": dict(lat1=41.974, lat2=41.988, lng1=-87.666, lng2=-87.649),
    "Edgewater":     dict(lat1=41.981, lat2=41.997, lng1=-87.666, lng2=-87.650),
    "West Ridge":    dict(lat1=41.981, lat2=41.997, lng1=-87.716, lng2=-87.680),
    "Albany Park":   dict(lat1=41.952, lat2=41.968, lng1=-87.740, lng2=-87.710),
}

BASE_URL = "https://www.redfin.com/stingray/api/gis"

LAUNDRY_PATTERNS = re.compile(
    r"in[- ]?unit laund|in unit|washer[/ ]?dryer|w/d in|w/d unit|laundry in unit",
    re.IGNORECASE,
)
GROUND_FLOOR_PATTERNS = re.compile(
    r"\bunit\s*#?1\b|#1\b|apt\s*#?1\b|1st\s+floor|ground\s+floor|floor\s+1\b",
    re.IGNORECASE,
)


def fetch_neighborhood(name, bbox):
    params = {
        "al": 1,
        "market": "chicago",
        "min_beds": 2,
        "min_baths": 2,
        "max_price": 700000,
        "status": 1,
        "uipt": "1,2",
        "sf": "1,2,3,5,6,7",
        "start": 0,
        "count": 50,
        "v": 8,
        **bbox,
    }
    resp = requests.get(BASE_URL, params=params, headers=HEADERS, timeout=20)
    resp.raise_for_status()
    text = resp.text
    # Strip {}&&  prefix
    if text.startswith("{}&&"):
        text = text[4:]
    return json.loads(text)


def extract_homes(data, neighborhood):
    homes = []
    payload = data.get("payload", {})
    raw_homes = payload.get("homes", [])
    for h in raw_homes:
        hd = h.get("homeData", h)  # some responses nest under homeData
        if not hd:
            continue

        # City filter
        city = (hd.get("addressInfo", {}) or {}).get("city", "") or ""
        if city not in ("Evanston", "Chicago"):
            continue

        # Address
        addr_info = hd.get("addressInfo", {}) or {}
        street = (addr_info.get("streetLine", {}) or {}).get("value", "")
        unit = addr_info.get("unitNumber", {}) or {}
        unit_str = unit.get("value", "") if isinstance(unit, dict) else str(unit)
        state = addr_info.get("state", "IL")
        zipcode = addr_info.get("zip", "")
        address = f"{street}{' ' + unit_str if unit_str else ''}, {city}, {state} {zipcode}"

        # Price
        price_info = hd.get("priceInfo", {}) or {}
        price = price_info.get("amount", 0)
        price_level = price_info.get("level", None)

        # Stats
        beds = (hd.get("beds", None) or hd.get("bedsInfo", {}) or {}).get("value") if isinstance(hd.get("bedsInfo"), dict) else hd.get("beds")
        baths = hd.get("baths", None)
        sqft_info = hd.get("sqFt", {}) or {}
        sqft = sqft_info.get("value") if isinstance(sqft_info, dict) else sqft_info

        hoa_info = hd.get("hoaInfo", {}) or {}
        hoa = hoa_info.get("amount") if isinstance(hoa_info, dict) else None

        dom_info = hd.get("dom", {}) or {}
        dom = dom_info.get("value") if isinstance(dom_info, dict) else dom_info

        yr = hd.get("yearBuilt", {}) or {}
        year_built = yr.get("value") if isinstance(yr, dict) else yr

        lat = hd.get("latLong", {}) and hd["latLong"].get("value", {}) and hd["latLong"]["value"].get("latitude")
        lng = hd.get("latLong", {}) and hd["latLong"].get("value", {}) and hd["latLong"]["value"].get("longitude")

        url = hd.get("url", "")
        redfin_url = "https://www.redfin.com" + url if url else ""

        tags = [t.get("label", "") for t in (hd.get("listingTags") or []) if isinstance(t, dict)]
        remarks = (hd.get("listingRemarks") or "")[:400]
        mls_id = (hd.get("mlsId", {}) or {}).get("value") if isinstance(hd.get("mlsId"), dict) else hd.get("mlsId")
        property_id = hd.get("propertyId", None)

        homes.append({
            "neighborhood": neighborhood,
            "address": address,
            "city": city,
            "price": price,
            "price_level": price_level,
            "beds": beds,
            "baths": baths,
            "sqft": sqft,
            "hoa": hoa,
            "dom": dom,
            "year_built": year_built,
            "lat": lat,
            "lng": lng,
            "redfin_url": redfin_url,
            "listing_tags": tags,
            "remarks": remarks,
            "mls_id": mls_id,
            "property_id": property_id,
            # raw home data for completeness
            "_raw": hd,
        })
    return homes


def pre_filter(listing):
    """Return (passes, flags) tuple."""
    flags = []

    if listing.get("price_level") != 1:
        return False, ["address_hidden"]

    hoa = listing.get("hoa") or 0
    if hoa and hoa > 900:
        flags.append(f"high_hoa=${hoa}")

    sqft = listing.get("sqft") or 0
    if sqft and sqft < 1200:
        flags.append(f"small_sqft={sqft}")

    search_text = " ".join([
        listing.get("remarks", "") or "",
        " ".join(listing.get("listing_tags", []) or []),
        listing.get("address", "") or "",
    ]).lower()

    if LAUNDRY_PATTERNS.search(search_text):
        flags.append("in_unit_laundry")

    if GROUND_FLOOR_PATTERNS.search(search_text):
        flags.append("ground_floor_risk")

    return True, flags


def main():
    all_listings = []
    summary = []

    for name, bbox in NEIGHBORHOODS.items():
        print(f"Fetching {name}...", end=" ", flush=True)
        try:
            data = fetch_neighborhood(name, bbox)
            homes = extract_homes(data, name)
            total = len(homes)

            passing = []
            for h in homes:
                ok, flags = pre_filter(h)
                h["flags"] = flags
                h["passes_prefilter"] = ok
                if ok:
                    passing.append(h)

            all_listings.extend(homes)
            summary.append((name, total, len(passing)))
            print(f"{total} listings, {len(passing)} pass pre-filter")
        except Exception as e:
            print(f"ERROR: {e}")
            summary.append((name, 0, 0))
        time.sleep(0.8)  # be polite

    # Save raw results (exclude _raw to keep file manageable, but keep all fields)
    out = []
    for h in all_listings:
        row = {k: v for k, v in h.items() if k != "_raw"}
        out.append(row)

    out_path = Path("~/Projects/lifeos/chicago-listings-raw.json").expanduser()
    with open(out_path, "w") as f:
        json.dump(out, f, indent=2)
    print(f"\nSaved {len(out)} listings → {out_path}")

    # Summary table
    print("\n" + "=" * 62)
    print(f"{'Neighborhood':<18} {'Total':>8} {'Pre-filter pass':>16}")
    print("-" * 62)
    total_all = 0
    total_pass = 0
    for name, total, passing in summary:
        print(f"{name:<18} {total:>8} {passing:>16}")
        total_all += total
        total_pass += passing
    print("-" * 62)
    print(f"{'TOTAL':<18} {total_all:>8} {total_pass:>16}")
    print("=" * 62)

    # Quick peek at top candidates
    candidates = [h for h in out if h.get("passes_prefilter")]
    candidates.sort(key=lambda x: x.get("price", 9e9))
    print(f"\nTop 10 candidates by price:")
    print(f"{'Address':<45} {'Price':>10} {'Beds':>4} {'Bths':>4} {'Sqft':>6} {'HOA':>6} {'DOM':>4} Flags")
    print("-" * 110)
    for h in candidates[:10]:
        addr = h["address"][:43]
        price = f"${h['price']:,}" if h.get("price") else "N/A"
        beds = h.get("beds") or "-"
        baths = h.get("baths") or "-"
        sqft = h.get("sqft") or "-"
        hoa = f"${h['hoa']}" if h.get("hoa") else "-"
        dom = h.get("dom") or "-"
        flags = ", ".join(h.get("flags", [])) or "clean"
        print(f"{addr:<45} {price:>10} {str(beds):>4} {str(baths):>4} {str(sqft):>6} {hoa:>6} {str(dom):>4}  {flags}")


if __name__ == "__main__":
    main()
