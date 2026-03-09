"""Sun exposure analysis for an address using Nominatim + OSM Overpass."""
import math
import re
import time

import httpx

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
]
HEADERS = {"User-Agent": "lifeos-agent/1.0"}

# Distance threshold (m) for blocks_light when building height is unknown
BLOCKS_LIGHT_DIST_M = 8.0


# ---------------------------------------------------------------------------
# Geo helpers
# ---------------------------------------------------------------------------

def _haversine(lat1, lon1, lat2, lon2):
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _bearing(lat1, lon1, lat2, lon2):
    dlon = math.radians(lon2 - lon1)
    lat1r, lat2r = math.radians(lat1), math.radians(lat2)
    x = math.sin(dlon) * math.cos(lat2r)
    y = math.cos(lat1r) * math.sin(lat2r) - math.sin(lat1r) * math.cos(lat2r) * math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def _to_cardinal(b):
    return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][round(b / 45) % 8]


def _point_left_of_seg(px, py, ax, ay, bx, by):
    """True if point (px,py) is left of the directed line from (ax,ay) to (bx,by)."""
    return ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) > 0


_DIR_ALIASES = {
    "n": "N", "north": "N",
    "s": "S", "south": "S",
    "e": "E", "east": "E",
    "w": "W", "west": "W",
    "ne": "NE", "northeast": "NE",
    "nw": "NW", "northwest": "NW",
    "se": "SE", "southeast": "SE",
    "sw": "SW", "southwest": "SW",
}


def _parse_unit(address):
    """Extract floor and facing direction from a unit identifier.

    Returns (floor: int, floor_estimated: bool, facing: str|None, facing_known: bool).

    Facing is a compass string ('N','S','E','W','NE',…) when derivable, else None.

    Examples:
      '#3S'  / '#3-S'  / 'Apt 3S'  → floor=3, facing='S', known=True
      '#2NE'                        → floor=2, facing='NE', known=True
      '#301'                        → floor=3, facing=None, known=False
      '#2B'                         → floor=2, facing=None, known=False
      no unit                       → floor=1, facing=None, known=False
    """
    m = re.search(r"(?:#|apt\.?\s*|unit\s*|suite\s*)([A-Za-z0-9][-A-Za-z0-9]*)", address, re.IGNORECASE)
    if not m:
        return 1, False, None, False

    unit = m.group(1).strip("-")

    # Try to split into numeric part + directional suffix  e.g. "3S", "301N", "2NE"
    dm = re.match(r"^(\d+)-?([A-Za-z]+)$", unit)
    if dm:
        num_part, alpha_part = dm.group(1), dm.group(2).lower()
        floor = max(1, int(str(num_part)[0]))
        facing = _DIR_ALIASES.get(alpha_part)
        if facing:
            return floor, True, facing, True
        # Alpha part is a room label (A, B, C…), not a direction
        return floor, True, None, False

    # Pure digits e.g. "301"
    dm = re.match(r"^(\d+)$", unit)
    if dm:
        floor = max(1, int(str(dm.group(1))[0]))
        return floor, True, None, False

    # Pure alpha e.g. "A", "B" → ground floor, no facing
    return 1, True, None, False


def _extract_street(address):
    """Pull the street name out of a full address string.

    '2751 W Giddings St, Chicago, IL' → 'w giddings st'
    Strips leading house number, lowercases, trims to pre-comma portion.
    """
    part = address.split(",")[0].strip()
    part = re.sub(r"^\d+\s*", "", part)  # remove leading house number
    return part.lower().strip()


def _names_match(osm_name, target_street):
    """True if the OSM way name is a plausible match for the target street string.

    Checks for shared significant words (ignoring directional prefixes and
    common suffix abbreviations so 'W Giddings St' matches 'West Giddings Street').
    """
    IGNORE = {"n", "s", "e", "w", "north", "south", "east", "west",
               "st", "ave", "blvd", "dr", "rd", "pl", "ct", "ln", "way",
               "street", "avenue", "boulevard", "drive", "road", "place"}
    def sig_words(s):
        return {w for w in re.sub(r"[^a-z0-9 ]", "", s.lower()).split() if w not in IGNORE}

    a = sig_words(osm_name)
    b = sig_words(target_street)
    return bool(a & b)  # at least one significant word in common


def _point_in_polygon(lat, lon, nodes):
    """Ray-casting point-in-polygon. nodes: list of (lat, lon) tuples."""
    inside = False
    j = len(nodes) - 1
    for i, (lat_i, lon_i) in enumerate(nodes):
        lat_j, lon_j = nodes[j]
        if ((lat_i > lat) != (lat_j > lat)) and \
           (lon < (lon_j - lon_i) * (lat - lat_i) / (lat_j - lat_i) + lon_i):
            inside = not inside
        j = i
    return inside


def _find_subject_building_id(lat, lon, buildings):
    """Return the OSM id of the subject building.

    Strategy:
    1. Point-in-polygon — exact match when geocoded point is inside the footprint.
    2. Nearest-node fallback — when the geocoded point lands on the entrance/edge
       of a large building (outside the polygon), identify it as the building whose
       closest node is within 20m.
    """
    # 1. Containment check
    for bld in buildings:
        nodes = [(n["lat"], n["lon"]) for n in bld.get("geometry", [])]
        if len(nodes) >= 3 and _point_in_polygon(lat, lon, nodes):
            return bld.get("id")

    # 2. Nearest-node fallback
    best_id = None
    best_dist = float("inf")
    for bld in buildings:
        for n in bld.get("geometry", []):
            d = _haversine(lat, lon, n["lat"], n["lon"])
            if d < best_dist:
                best_dist = d
                best_id = bld.get("id")
    return best_id if best_dist <= 20 else None


# Typical heights by OSM building type (metres).  Used only when no explicit
# height or level count is tagged — gives better blocks_light than a bare
# distance threshold.
_BUILDING_TYPE_HEIGHTS = {
    "bungalow": 3.5,
    "shed": 3.0,
    "garage": 3.0,
    "garages": 3.0,
    "carport": 3.0,
    "roof": 3.0,
    "house": 6.0,
    "detached": 6.0,
    "semidetached_house": 6.0,
    "terrace": 7.0,
    "residential": 9.0,
    "apartments": 10.5,
    "dormitory": 10.5,
    "hotel": 12.0,
    "commercial": 10.5,
    "retail": 5.0,
    "office": 12.0,
    "industrial": 8.0,
    "warehouse": 8.0,
    "school": 9.0,
    "university": 10.5,
    "church": 14.0,
    "cathedral": 20.0,
    "civic": 10.5,
    "public": 9.0,
    "yes": 7.0,       # generic "building=yes" — assume ~2 floors
}


def _parse_height(tags):
    """Return (height_m, is_estimated).

    Priority: explicit height tag → levels × 3.5 → building-type lookup → None.
    """
    if "height" in tags:
        try:
            return float(str(tags["height"]).replace("m", "").strip()), False
        except (ValueError, AttributeError):
            pass
    if "building:levels" in tags:
        try:
            return float(tags["building:levels"]) * 3.5, False
        except (ValueError, AttributeError):
            pass
    btype = tags.get("building", "").lower()
    if btype in _BUILDING_TYPE_HEIGHTS:
        return _BUILDING_TYPE_HEIGHTS[btype], True
    return None, True


# ---------------------------------------------------------------------------
# Data fetching
# ---------------------------------------------------------------------------

def _overpass_post(query):
    """POST a query to Overpass, falling back through mirrors on timeout."""
    last_exc = None
    for url in OVERPASS_MIRRORS:
        try:
            resp = httpx.post(url, data={"data": query}, timeout=30, headers=HEADERS)
            resp.raise_for_status()
            return resp
        except (httpx.TimeoutException, httpx.HTTPStatusError) as e:
            last_exc = e
            continue
    raise last_exc

def _geocode(address):
    time.sleep(1)
    resp = httpx.get(
        NOMINATIM_URL,
        params={"q": address, "format": "json", "limit": 1},
        headers=HEADERS,
        timeout=10,
    )
    resp.raise_for_status()
    results = resp.json()
    if not results:
        raise ValueError(f"No geocoding results for: {address}")
    return float(results[0]["lat"]), float(results[0]["lon"])


def _query_area(lat, lon, road_radius=80):
    """Single Overpass call: nearby driveable roads + buildings."""
    query = f"""[out:json];
(
  way(around:{road_radius},{lat},{lon})[highway][highway!~"footway|path|cycleway|service|steps|pedestrian"];
  way["building"](around:80,{lat},{lon});
);
out geom tags;"""
    resp = _overpass_post(query)
    elements = resp.json().get("elements", [])
    roads = [e for e in elements if "highway" in e.get("tags", {})]
    buildings = [e for e in elements if "building" in e.get("tags", {})]
    return roads, buildings


def _fetch_roads(lat, lon, radius):
    """Fetch only roads at a given radius (used for expanded street search)."""
    query = f"""[out:json];
way(around:{radius},{lat},{lon})[highway][highway!~"footway|path|cycleway|service|steps|pedestrian"];
out geom tags;"""
    return _overpass_post(query).json().get("elements", [])


# ---------------------------------------------------------------------------
# Street bearing
# ---------------------------------------------------------------------------

def _best_segment(lat, lon, roads, target_street=None):
    """Find the best road segment in a list of ways.

    If target_street is given, prefer the nearest name-matching segment over
    the globally nearest. Returns (way, seg_tuple, dist) or (None, None, inf).
    """
    nearest_way, nearest_seg, nearest_dist = None, None, float("inf")
    match_way, match_seg, match_dist = None, None, float("inf")

    for way in roads:
        geom = way.get("geometry", [])
        tags = way.get("tags", {})
        osm_name = tags.get("name", tags.get("ref", ""))
        is_match = target_street and osm_name and _names_match(osm_name, target_street)

        for i in range(len(geom) - 1):
            a, b = geom[i], geom[i + 1]
            mid_lat = (a["lat"] + b["lat"]) / 2
            mid_lon = (a["lon"] + b["lon"]) / 2
            d = _haversine(lat, lon, mid_lat, mid_lon)

            if d < nearest_dist:
                nearest_dist = d
                nearest_way, nearest_seg = way, (a, b)
            if is_match and d < match_dist:
                match_dist = d
                match_way, match_seg = way, (a, b)

    if match_seg is not None:
        return match_way, match_seg, match_dist
    return nearest_way, nearest_seg, nearest_dist


def _nearest_road_segment(lat, lon, roads, target_street=None):
    """Returns (street_name, street_bearing, front_bearing).

    Prefers a segment whose name matches target_street. If none found in the
    provided roads list, expands the search to 200m before falling back to nearest.
    """
    way, seg, _ = _best_segment(lat, lon, roads, target_street)

    # If target_street was given and the best result doesn't match, try wider radius
    if target_street and way is not None:
        osm_name = way.get("tags", {}).get("name", way.get("tags", {}).get("ref", ""))
        if not _names_match(osm_name, target_street):
            wider_roads = _fetch_roads(lat, lon, 200)
            w_way, w_seg, _ = _best_segment(lat, lon, wider_roads, target_street)
            if w_seg is not None:
                w_name = w_way.get("tags", {}).get("name", w_way.get("tags", {}).get("ref", ""))
                if _names_match(w_name, target_street):
                    way, seg = w_way, w_seg

    if not seg:
        raise ValueError("No road segment found near address")

    a, b = seg
    street_bearing = _bearing(a["lat"], a["lon"], b["lat"], b["lon"])
    left = _point_left_of_seg(lon, lat, a["lon"], a["lat"], b["lon"], b["lat"])
    front_bearing = (street_bearing + 90) % 360 if left else (street_bearing - 90) % 360

    tags = way.get("tags", {})
    name = tags.get("name", tags.get("ref", "unknown"))
    highway_type = tags.get("highway", "unknown")
    return name, street_bearing, front_bearing, highway_type


# ---------------------------------------------------------------------------
# Building distances
# ---------------------------------------------------------------------------

def _building_edge_in_direction(lat, lon, bearing_deg, subject_bld):
    """Return the furthest node of subject_bld's footprint in the given direction.

    This gives the correct origin for gap measurements — e.g. the south edge
    of the building when measuring south, rather than the geocoded entry point.
    """
    nodes = [(n["lat"], n["lon"]) for n in subject_bld.get("geometry", [])] if subject_bld else []
    if not nodes:
        return lat, lon
    bearing_r = math.radians(bearing_deg)
    best_proj = -float("inf")
    best = (lat, lon)
    cos_lat = math.cos(math.radians(lat))
    for nlat, nlon in nodes:
        dlat = (nlat - lat) * 111000
        dlon = (nlon - lon) * 111000 * cos_lat
        proj = dlon * math.sin(bearing_r) + dlat * math.cos(bearing_r)
        if proj > best_proj:
            best_proj = proj
            best = (nlat, nlon)
    return best


def _ray_segment_intersect(ox, oy, dx, dy, ax, ay, bx, by):
    """Return t >= 0 where the ray (ox+t*dx, oy+t*dy) intersects segment (a,b), or None."""
    # Solve: ox + t*dx = ax + s*(bx-ax)
    #        oy + t*dy = ay + s*(by-ay)
    # Cramers rule
    ex, ey = bx - ax, by - ay
    denom = dx * ey - dy * ex
    if abs(denom) < 1e-12:
        return None  # parallel
    t = ((ax - ox) * ey - (ay - oy) * ex) / denom
    s = ((ax - ox) * dy - (ay - oy) * dx) / denom
    if t >= 0 and 0.0 <= s <= 1.0:
        return t
    return None


def _nearest_building_in_direction(lat, lon, bearing, buildings, cone_deg=45, max_m=80, exclude_id=None):
    """Nearest building edge hit by a ray cast in `bearing` direction.

    Uses ray-polygon edge intersection instead of node proximity, so results
    are accurate regardless of where polygon corners fall.

    Returns (distance_m, height_m_or_None).
    """
    bearing_r = math.radians(bearing)
    # Ray direction in local metre space (north=+y, east=+x)
    dx = math.sin(bearing_r)
    dy = math.cos(bearing_r)
    cos_lat = math.cos(math.radians(lat))

    best_dist = max_m
    best_height = None
    best_estimated = True

    for bld in buildings:
        if exclude_id is not None and bld.get("id") == exclude_id:
            continue
        nodes = [(n["lat"], n["lon"]) for n in bld.get("geometry", [])]
        if len(nodes) < 2:
            continue
        tags = bld.get("tags", {})

        # Quick bearing check: skip buildings whose centroid is clearly outside cone
        c_lat = sum(n[0] for n in nodes) / len(nodes)
        c_lon = sum(n[1] for n in nodes) / len(nodes)
        c_bearing = _bearing(lat, lon, c_lat, c_lon)
        angle_diff = abs((c_bearing - bearing + 180) % 360 - 180)
        if angle_diff > cone_deg + 45:  # generous pre-filter
            continue

        # Project nodes to local metres relative to origin
        def to_xy(nlat, nlon):
            return (nlon - lon) * 111000 * cos_lat, (nlat - lat) * 111000

        # Check every edge of the building polygon
        for i in range(len(nodes)):
            ax, ay = to_xy(*nodes[i])
            bx, by = to_xy(*nodes[(i + 1) % len(nodes)])
            t = _ray_segment_intersect(0, 0, dx, dy, ax, ay, bx, by)
            if t is None or t > best_dist:
                continue
            # Verify the hit point is within the angular cone
            hit_x, hit_y = dx * t, dy * t
            hit_bearing = (math.degrees(math.atan2(hit_x, hit_y)) + 360) % 360
            hit_angle_diff = abs((hit_bearing - bearing + 180) % 360 - 180)
            if hit_angle_diff > cone_deg:
                continue
            best_dist = t
            best_height, best_estimated = _parse_height(tags)

    return best_dist, best_height, best_estimated


_BLOCKS_LIGHT_TAN = math.tan(math.radians(20))  # elevation angle threshold: 20°


def _side_info(lat, lon, bearing, buildings, is_front=False, exclude_id=None, subject_bld=None, eye_height_m=0.0):
    # Measure from the building's edge in this direction, not the geocoded centre
    if subject_bld is not None:
        origin_lat, origin_lon = _building_edge_in_direction(lat, lon, bearing, subject_bld)
    else:
        origin_lat, origin_lon = lat, lon
    dist, height, height_estimated = _nearest_building_in_direction(origin_lat, origin_lon, bearing, buildings, exclude_id=exclude_id)
    open_val = dist > BLOCKS_LIGHT_DIST_M

    if is_front:
        blocks = False
    elif height is not None:
        # How much of the obstruction is above the unit's eye level
        effective_h = height - eye_height_m
        if effective_h <= 0:
            blocks = False  # obstruction is entirely below the unit's floor
        else:
            blocks = (effective_h / max(dist, 0.1)) > _BLOCKS_LIGHT_TAN
    else:
        blocks = not open_val

    return {
        "direction": _to_cardinal(bearing),
        "open": open_val,
        "open_distance_m": round(dist, 1),
        "obstruction_height_m": round(height, 1) if height is not None else None,
        "height_estimated": height_estimated if height is not None else None,
        "blocks_light": blocks,
    }


# ---------------------------------------------------------------------------
# Corner detection
# ---------------------------------------------------------------------------

def _check_corner(lat, lon, roads, street_bearing, front_bearing, buildings, exclude_id=None, subject_bld=None):
    """Return corner_side dict if at an intersection within ~20m, else None.

    Requires that the intersecting road has a node within 20m of our point
    (tight threshold to avoid diagonal roads that merely pass nearby).
    """
    for way in roads:
        geom = way.get("geometry", [])
        for i in range(len(geom) - 1):
            a, b = geom[i], geom[i + 1]
            da = _haversine(lat, lon, a["lat"], a["lon"])
            db = _haversine(lat, lon, b["lat"], b["lon"])
            # Both nodes must be reachable, and at least one must be very close
            if min(da, db) > 20:
                continue
            seg_bearing = _bearing(a["lat"], a["lon"], b["lat"], b["lon"])
            angle_diff = abs((seg_bearing - street_bearing + 180) % 360 - 180)
            if 30 < angle_diff < 150:  # intersecting road, not the same street
                left_bearing = (front_bearing - 90) % 360
                right_bearing = (front_bearing + 90) % 360
                dl = abs((seg_bearing - left_bearing + 180) % 360 - 180)
                dr = abs((seg_bearing - right_bearing + 180) % 360 - 180)
                corner_bearing = left_bearing if dl < dr else right_bearing
                return _side_info(lat, lon, corner_bearing, buildings, exclude_id=exclude_id, subject_bld=subject_bld)
    return None


# ---------------------------------------------------------------------------
# Neighborhood data
# ---------------------------------------------------------------------------

_HIGHWAY_LABELS = {
    "motorway": "highway",
    "trunk": "trunk road",
    "primary": "major arterial",
    "secondary": "secondary arterial",
    "tertiary": "minor collector",
    "unclassified": "local road",
    "residential": "residential street",
    "living_street": "living street",
    "service": "service road",
}

_TRANSIT_TAGS = {"railway", "public_transport", "highway"}
_TRANSIT_TYPES = {
    "subway_entrance", "station", "tram_stop", "stop_position", "bus_stop",
}

_AMENITY_CATEGORIES = {
    "supermarket": "grocery", "grocery": "grocery",
    "pharmacy": "pharmacy", "chemist": "pharmacy",
    "cafe": "cafe", "coffee": "cafe",
    "restaurant": "restaurant", "fast_food": "restaurant",
    "bar": "bar", "pub": "bar",
    "bakery": "bakery",
    "gym": "gym", "fitness_centre": "gym",
}


def _query_neighborhood(lat, lon):
    """Single Overpass call for transit, amenities, parks, and alley."""
    query = f"""[out:json];
(
  node(around:600,{lat},{lon})[highway=bus_stop];
  node(around:600,{lat},{lon})[public_transport=stop_position];
  node(around:600,{lat},{lon})[railway~"station|subway_entrance|tram_stop"];
  node(around:500,{lat},{lon})[amenity~"supermarket|grocery|pharmacy|cafe|restaurant|fast_food|bar|bakery|gym"];
  node(around:500,{lat},{lon})[shop~"supermarket|grocery|convenience|chemist|bakery"];
  way(around:600,{lat},{lon})[leisure=park];
  node(around:600,{lat},{lon})[leisure=park];
  way(around:100,{lat},{lon})[highway=service][service=alley];
);
out center tags;"""
    return _overpass_post(query).json().get("elements", [])


def _fetch_flood_zone(lat, lon):
    """Query FEMA NFHL for flood zone at the given point. Returns zone string or None."""
    url = (
        "https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL/MapServer/28/query"
        f"?geometry={lon},{lat}&geometryType=esriGeometryPoint&inSR=4326"
        "&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,ZONE_SUBTY"
        "&returnGeometry=false&f=json"
    )
    try:
        resp = httpx.get(url, timeout=10, headers=HEADERS)
        features = resp.json().get("features", [])
        if features:
            attrs = features[0].get("attributes", {})
            zone = attrs.get("FLD_ZONE", "")
            subtype = attrs.get("ZONE_SUBTY", "")
            return f"{zone} ({subtype})" if subtype else zone
    except Exception:
        pass
    return None


def _fetch_elevation(lat, lon):
    """Return elevation in metres via OpenTopoData (NED 10m for CONUS)."""
    try:
        resp = httpx.get(
            f"https://api.opentopodata.org/v1/ned10m?locations={lat},{lon}",
            timeout=10, headers=HEADERS,
        )
        results = resp.json().get("results", [])
        if results and results[0].get("elevation") is not None:
            return round(results[0]["elevation"], 1)
    except Exception:
        pass
    return None


def _build_neighborhood(elements, lat, lon):
    """Distil raw Overpass elements into structured neighborhood dict."""
    transit_stops = []
    amenity_nearest = {}  # category → (dist, name)
    parks = []
    has_alley = False

    for el in elements:
        tags = el.get("tags", {})
        # Centre point for ways
        c = el.get("center") or el
        elat, elon = c.get("lat"), c.get("lon")
        if elat is None or elon is None:
            continue
        dist = round(_haversine(lat, lon, elat, elon))

        # Alley
        if tags.get("highway") == "service" and tags.get("service") == "alley":
            has_alley = True
            continue

        # Parks
        if tags.get("leisure") == "park":
            parks.append((dist, tags.get("name", "unnamed park")))
            continue

        # Transit
        hw = tags.get("highway", "")
        rw = tags.get("railway", "")
        pt = tags.get("public_transport", "")
        if hw == "bus_stop" or rw in {"station", "subway_entrance", "tram_stop"} or pt == "stop_position":
            stop_type = (
                "subway" if rw in {"subway_entrance", "station"} and tags.get("station") == "subway"
                else "train" if rw == "station"
                else "tram" if rw == "tram_stop"
                else "bus"
            )
            name = tags.get("name", tags.get("ref", ""))
            transit_stops.append((dist, stop_type, name))
            continue

        # Amenities
        amenity = tags.get("amenity", tags.get("shop", ""))
        category = _AMENITY_CATEGORIES.get(amenity)
        if category:
            name = tags.get("name", "")
            if category not in amenity_nearest or dist < amenity_nearest[category][0]:
                amenity_nearest[category] = (dist, name)

    transit_stops.sort()
    parks.sort()

    nearest_transit = None
    if transit_stops:
        d, t, n = transit_stops[0]
        nearest_transit = {"type": t, "name": n or None, "distance_m": d}

    nearest_park = None
    if parks:
        d, n = parks[0]
        nearest_park = {"name": n, "distance_m": d}

    walkability = {
        cat: {"distance_m": v[0], "name": v[1] or None}
        for cat, v in sorted(amenity_nearest.items())
    }

    return {
        "nearest_transit": nearest_transit,
        "walkability": walkability,
        "nearest_park": nearest_park,
        "alley_behind": has_alley,
    }


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def property_report(address):
    warnings = []

    # 1. Geocode
    try:
        # Strip unit identifiers before geocoding — Nominatim can't resolve them
        geocode_address = re.sub(r"\s*(?:#|apt\.?\s*|unit\s*|suite\s*)\S+", "", address, flags=re.IGNORECASE).strip().strip(",")
        lat, lon = _geocode(geocode_address)
    except Exception as e:
        return {"address": address, "warning": f"Geocoding failed: {e}"}

    # 2. Single OSM query for roads + buildings
    try:
        roads, buildings = _query_area(lat, lon)
    except Exception as e:
        return {
            "address": address,
            "coordinates": [round(lat, 5), round(lon, 5)],
            "warning": f"OSM query failed: {e}",
        }

    # 3. Street bearing + front direction
    target_street = _extract_street(address)
    street_name = "unknown"
    street_bearing = 0.0
    front_bearing = 0.0
    highway_type = "unknown"
    try:
        street_name, street_bearing, front_bearing, highway_type = _nearest_road_segment(lat, lon, roads, target_street)
    except Exception as e:
        warnings.append(f"Street bearing failed: {e}")

    rear_bearing = (front_bearing + 180) % 360
    left_bearing = (front_bearing - 90) % 360
    right_bearing = (front_bearing + 90) % 360

    # 4. Identify subject building + unit floor
    subject_id = _find_subject_building_id(lat, lon, buildings)
    subject_bld = next((b for b in buildings if b.get("id") == subject_id), None)
    subject_height, subject_height_estimated = _parse_height(subject_bld.get("tags", {}) if subject_bld else {})

    floor, floor_estimated, unit_facing, unit_facing_known = _parse_unit(address)
    FLOOR_HEIGHT_M = 3.5
    eye_height_m = (floor - 1) * FLOOR_HEIGHT_M  # height of unit's windows above ground

    # 5. Side distances + blocks_light
    def safe_side(bearing, is_front=False):
        try:
            return _side_info(lat, lon, bearing, buildings, is_front=is_front, exclude_id=subject_id, subject_bld=subject_bld, eye_height_m=eye_height_m)
        except Exception as e:
            warnings.append(str(e))
            return {
                "direction": _to_cardinal(bearing),
                "open": None,
                "open_distance_m": None,
                "blocks_light": None,
            }

    all_sides = {
        _to_cardinal(front_bearing): safe_side(front_bearing, is_front=True),
        _to_cardinal(rear_bearing): safe_side(rear_bearing),
        _to_cardinal(left_bearing): safe_side(left_bearing),
        _to_cardinal(right_bearing): safe_side(right_bearing),
    }

    # When the unit's facing direction is known, tag each side with whether the
    # unit has windows there. A unit faces its primary direction + adjacent sides
    # for corner units. For a non-corner unit, only the facing side has windows.
    def _has_windows(side_dir, facing):
        """True if a unit facing `facing` plausibly has windows on `side_dir`."""
        if facing is None:
            return True  # unknown — show everything
        # Primary facing always has windows
        if side_dir == facing:
            return True
        # Corner facings (NE/NW/SE/SW) expose two cardinal sides
        corner_map = {
            "NE": {"N", "E"}, "NW": {"N", "W"},
            "SE": {"S", "E"}, "SW": {"S", "W"},
        }
        if facing in corner_map and side_dir in corner_map[facing]:
            return True
        return False

    front = all_sides[_to_cardinal(front_bearing)]
    rear = all_sides[_to_cardinal(rear_bearing)]
    left = all_sides[_to_cardinal(left_bearing)]
    right = all_sides[_to_cardinal(right_bearing)]

    # Annotate each side with unit_has_windows
    for cardinal, side in all_sides.items():
        side["unit_has_windows"] = _has_windows(cardinal, unit_facing)

    # 6. Corner check
    corner_side = None
    try:
        corner_side = _check_corner(lat, lon, roads, street_bearing, front_bearing, buildings, exclude_id=subject_id, subject_bld=subject_bld)
    except Exception as e:
        warnings.append(f"Corner check failed: {e}")

    # 7. Neighborhood data (wider OSM query + external APIs, best-effort)
    neighborhood = {}
    try:
        nb_elements = _query_neighborhood(lat, lon)
        neighborhood = _build_neighborhood(nb_elements, lat, lon)
    except Exception as e:
        warnings.append(f"Neighborhood query failed: {e}")

    try:
        neighborhood["flood_zone"] = _fetch_flood_zone(lat, lon)
    except Exception:
        neighborhood["flood_zone"] = None

    try:
        neighborhood["elevation_m"] = _fetch_elevation(lat, lon)
    except Exception:
        neighborhood["elevation_m"] = None

    return {
        "address": address,
        "coordinates": [round(lat, 5), round(lon, 5)],
        "street": street_name,
        "street_type": _HIGHWAY_LABELS.get(highway_type, highway_type),
        "bearing_degrees": round(street_bearing, 1),
        "subject_height_m": round(subject_height, 1) if subject_height is not None else None,
        "subject_height_estimated": subject_height_estimated if subject_height is not None else None,
        "unit_floor": floor,
        "unit_floor_estimated": floor_estimated,
        "unit_facing": unit_facing,
        "unit_facing_known": unit_facing_known,
        "front": front,
        "rear": rear,
        "left": left,
        "right": right,
        "corner_side": corner_side,
        "neighborhood": neighborhood,
        "warning": "; ".join(warnings) if warnings else None,
    }
