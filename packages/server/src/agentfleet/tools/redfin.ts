import * as cheerio from 'cheerio';

// ── Constants ─────────────────────────────────────────────────────────────────

const USER_AGENT = 'lifeos-agent/1.0';
const TIMEOUT_MS = 20_000;
const EARTH_R = 6_371_000;           // meters
const DEG_PER_M = 1 / 111_000;      // approx degrees per meter of latitude
const BLOCKS_LIGHT_DIST_M = 8.0;    // minimum distance for tan calculation
const BLOCKS_LIGHT_TAN = Math.tan(20 * Math.PI / 180); // tan(20°) ≈ 0.364
const FLOOR_HEIGHT_M = 3.5;         // meters per floor

const BUILDING_TYPE_HEIGHTS: Record<string, number> = {
  bungalow: 3.5,  shed: 3.0, garage: 3.0, garages: 3.0, carport: 3.0, roof: 3.0,
  house: 6.0, detached: 6.0, semidetached_house: 6.0, terrace: 7.0,
  residential: 9.0, apartments: 10.5, dormitory: 10.5, hotel: 12.0,
  commercial: 10.5, retail: 5.0, office: 12.0, industrial: 8.0, warehouse: 8.0,
  school: 9.0, university: 10.5, church: 14.0, cathedral: 20.0,
  civic: 10.5, public: 9.0, yes: 7.0,
};

const HIGHWAY_LABELS: Record<string, string> = {
  motorway: 'highway', trunk: 'trunk road', primary: 'major arterial',
  secondary: 'secondary arterial', tertiary: 'minor collector',
  unclassified: 'local road', residential: 'residential street',
  living_street: 'living street', service: 'service road',
};

const AMENITY_CATEGORIES: Record<string, string> = {
  supermarket: 'grocery', grocery: 'grocery', convenience: 'grocery',
  pharmacy: 'pharmacy', chemist: 'pharmacy',
  cafe: 'cafe', coffee: 'cafe',
  restaurant: 'restaurant', fast_food: 'restaurant',
  bar: 'bar', pub: 'bar',
  bakery: 'bakery', gym: 'gym', fitness_centre: 'gym',
};

const DIR_ALIASES: Record<string, string> = {
  n: 'N', north: 'N', s: 'S', south: 'S', e: 'E', east: 'E', w: 'W', west: 'W',
  ne: 'NE', northeast: 'NE', nw: 'NW', northwest: 'NW',
  se: 'SE', southeast: 'SE', sw: 'SW', southwest: 'SW',
};

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
];

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function fetchHtml(url: string): Promise<{ html: string; finalUrl: string } | { error: string }> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
    });
    if (response.status >= 400) return { error: `HTTP ${response.status}` };
    return { html: await response.text(), finalUrl: response.url };
  } catch (err: any) {
    return { error: err?.name === 'TimeoutError' ? 'Request timed out' : (err?.message ?? 'Unknown error') };
  }
}

async function fetchJson<T>(url: string): Promise<T | { error: string }> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status >= 400) return { error: `HTTP ${response.status}` };
    return response.json() as Promise<T>;
  } catch (err: any) {
    return { error: err?.message ?? 'Unknown error' };
  }
}

async function overpassPost(query: string): Promise<any | null> {
  for (const mirror of OVERPASS_MIRRORS) {
    try {
      const response = await fetch(mirror, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) return response.json();
    } catch {}
  }
  return null;
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const phi1 = lat1 * Math.PI / 180, phi2 = lat2 * Math.PI / 180;
  const dphi = (lat2 - lat1) * Math.PI / 180;
  const dlam = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlam / 2) ** 2;
  return 2 * EARTH_R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const phi1 = lat1 * Math.PI / 180, phi2 = lat2 * Math.PI / 180;
  const dlam = (lng2 - lng1) * Math.PI / 180;
  const y = Math.sin(dlam) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dlam);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function toCardinal(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8]!;
}

// Convert lat/lng to local Cartesian meters relative to origin
function toLocal(originLat: number, originLng: number, lat: number, lng: number): [number, number] {
  const cLat = Math.cos(originLat * Math.PI / 180);
  return [(lng - originLng) * 111_000 * cLat, (lat - originLat) * 111_000];
}

// Ray-segment intersection: ray from origin (0,0) in direction (dx,dy), segment (ax,ay)→(bx,by)
// Returns distance along ray, or null if no intersection in positive direction
function raySegmentIntersect(dx: number, dy: number, ax: number, ay: number, bx: number, by: number): number | null {
  const ex = bx - ax, ey = by - ay;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < 1e-12) return null; // parallel
  const t = (ax * ey - ay * ex) / denom;
  const u = (ax * dy - ay * dx) / denom;
  if (t > 1e-9 && u >= 0 && u <= 1) return t;
  return null;
}

// ── OSM data helpers ──────────────────────────────────────────────────────────

function parseHeight(tags: Record<string, string>): { heightM: number; estimated: boolean } {
  if (tags['height']) {
    const h = parseFloat(tags['height']);
    if (!isNaN(h)) return { heightM: h, estimated: false };
  }
  if (tags['building:levels']) {
    const lvl = parseFloat(tags['building:levels']);
    if (!isNaN(lvl)) return { heightM: lvl * FLOOR_HEIGHT_M, estimated: true };
  }
  const typeH = BUILDING_TYPE_HEIGHTS[tags['building'] ?? ''];
  if (typeH != null) return { heightM: typeH, estimated: true };
  return { heightM: FLOOR_HEIGHT_M * 2, estimated: true }; // fallback: 2 floors
}

interface NearestBuilding { distM: number; heightM: number; heightEstimated: boolean }

// Find the nearest building edge in a given bearing from (lat, lng)
function nearestBuildingInDir(
  originLat: number, originLng: number, bearingDegrees: number,
  buildings: any[]
): NearestBuilding | null {
  const rad = bearingDegrees * Math.PI / 180;
  const dx = Math.sin(rad), dy = Math.cos(rad); // direction vector
  let best: NearestBuilding | null = null;

  for (const way of buildings) {
    const nodes: { lat: number; lon: number }[] = way.geometry ?? [];
    if (nodes.length < 2) continue;

    const { heightM, estimated } = parseHeight(way.tags ?? {});
    let minDist = Infinity;

    for (let i = 0; i < nodes.length - 1; i++) {
      const na = nodes[i], nb = nodes[i + 1];
      if (!na || !nb) continue;
      const [ax, ay] = toLocal(originLat, originLng, na.lat, na.lon);
      const [bx, by] = toLocal(originLat, originLng, nb.lat, nb.lon);
      const t = raySegmentIntersect(dx, dy, ax, ay, bx, by);
      if (t != null && t < minDist) minDist = t;
    }

    if (minDist < Infinity && (best == null || minDist < best.distM)) {
      best = { distM: minDist, heightM, heightEstimated: estimated };
    }
  }

  return best;
}

function nearestRoadSegment(
  originLat: number, originLng: number, ways: any[]
): { street: string; streetType: string; bearingDeg: number } | null {
  let bestDist = Infinity;
  let result: { street: string; streetType: string; bearingDeg: number } | null = null;

  for (const way of ways) {
    const nodes: { lat: number; lon: number }[] = way.geometry ?? [];
    const tags = way.tags ?? {};
    const highwayType = tags['highway'] ?? 'unclassified';
    const name = tags['name'] ?? '';
    for (let i = 0; i < nodes.length - 1; i++) {
      const na = nodes[i], nb = nodes[i + 1];
      if (!na || !nb) continue;
      // Midpoint distance
      const midLat = (na.lat + nb.lat) / 2, midLng = (na.lon + nb.lon) / 2;
      const d = haversineM(originLat, originLng, midLat, midLng);
      if (d < bestDist) {
        bestDist = d;
        const b = bearingDeg(na.lat, na.lon, nb.lat, nb.lon);
        result = {
          street: name,
          streetType: HIGHWAY_LABELS[highwayType] ?? highwayType,
          bearingDeg: Math.round(b * 10) / 10,
        };
      }
    }
  }
  return result;
}

// Parse unit token (e.g. "4N", "4", "B") → { floor, facing }
function parseUnit(address: string): { floor: number | null; facing: string | null } {
  const m = address.match(/(?:^|[\s,#])(?:#|apt\.?\s*|unit\s*|suite\s*)([A-Za-z0-9][-A-Za-z0-9]*)/i);
  if (!m?.[1]) {
    // Try bare suffix like "123 Main St 4N"
    const bare = address.match(/\s([0-9]+[A-Za-z]+|[A-Za-z]+[0-9]+)\s*(?:,|$)/);
    if (bare?.[1]) return parseUnitToken(bare[1]);
    return { floor: null, facing: null };
  }
  return parseUnitToken(m[1]);
}

function parseUnitToken(token: string): { floor: number | null; facing: string | null } {
  const t = token.replace(/^-+|-+$/, '');
  // Pattern: digits + letters (e.g. "4N", "12SE")
  const m1 = t.match(/^(\d+)-?([A-Za-z]+)$/);
  if (m1) {
    const floor = parseInt(m1[1]!);
    const dir = DIR_ALIASES[m1[2]!.toLowerCase()] ?? null;
    return { floor, facing: dir };
  }
  // Pure digits — 4-digit apartment codes (e.g. 2120) encode floor as first 2 digits
  if (/^\d+$/.test(t)) {
    const n = parseInt(t);
    if (t.length === 4 && n >= 1000) return { floor: Math.floor(n / 100), facing: null };
    return { floor: n, facing: null };
  }
  // Pure letters → direction only
  const dir = DIR_ALIASES[t.toLowerCase()] ?? null;
  return { floor: null, facing: dir };
}

function extractStreet(address: string): string {
  // Strip unit number, strip leading numbers, keep street name
  const stripped = address
    .replace(/(?:^|[\s,])(?:#|apt\.?\s*|unit\s*|suite\s*)\S+/gi, '')
    .trim();
  // Remove house number prefix
  return stripped.replace(/^\d+\s*/, '').split(',')[0]?.trim() ?? '';
}

// ── HTML helpers ─────────────────────────────────────────────────────────────

function extractNextData(html: string): any | null {
  try {
    const match = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (match?.[1]) return JSON.parse(match[1]);
  } catch {}
  return null;
}

// ── Redfin class ──────────────────────────────────────────────────────────────

export class Redfin {
  async parseListing(url: string): Promise<Record<string, any>> {
    const result = await fetchHtml(url);
    if ('error' in result) return { error: result.error, url };

    const { html, finalUrl } = result;
    const $ = cheerio.load(html);

    // Try JSON-LD structured data (most reliable)
    const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g);
    if (jsonLdMatch) {
      for (const block of jsonLdMatch) {
        try {
          const inner = block.replace(/<[^>]+>/g, '');
          const data = JSON.parse(inner);
          const entity = data?.mainEntity ?? data;
          if (entity?.['@type'] === 'SingleFamilyResidence' || entity?.['@type'] === 'Apartment' || entity?.price) {
            const addr = entity.address ?? {};
            const geo = entity.geo ?? {};
            return {
              url: finalUrl,
              address: [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.postalCode].filter(Boolean).join(', '),
              price: entity.price ?? entity.offers?.price,
              beds: entity.numberOfRooms,
              baths: entity.numberOfBathroomsTotal,
              coordinates: geo.latitude ? { lat: parseFloat(geo.latitude), lng: parseFloat(geo.longitude) } : undefined,
              description: entity.description,
            };
          }
        } catch {}
      }
    }

    // Try __NEXT_DATA__
    const nextData = extractNextData(html);
    if (nextData) {
      try {
        const props = nextData?.props?.pageProps;
        const listing = props?.listing ?? props?.initialRedfin?.listing ?? props?.aboveTheFold?.payload?.homeDetails;
        if (listing) return this.normalizeListingData(listing, finalUrl);
      } catch {}
    }

    // DOM fallback
    const price = $('.price .value, [data-rf-test-name="abp-price"], .homePriceAmount').first().text().trim();
    const beds = $('.beds .value, [data-rf-test-name="abp-beds"]').first().text().trim();
    const baths = $('.baths .value, [data-rf-test-name="abp-baths"]').first().text().trim();
    const sqft = $('.sqft .value, [data-rf-test-name="abp-sqFt"]').first().text().trim();
    const address = $('h1.street-address, [data-rf-test-name="abp-streetLine"]').first().text().trim() ||
                    ($('title').text().split('|')[0]?.trim() ?? '');

    if (!price && !address) {
      return { error: 'Could not extract listing data (page may require JS rendering)', url: finalUrl };
    }

    return { url: finalUrl, address, price, beds, baths, sqft };
  }

  private normalizeListingData(data: any, url: string): Record<string, any> {
    const basic = data?.basicInfo ?? data?.hdpData?.homeInfo ?? data;
    return {
      url,
      address: [basic?.streetLine, basic?.city, basic?.state, basic?.zip].filter(Boolean).join(', ') || basic?.address,
      price: basic?.price ?? basic?.lastSoldPrice,
      beds: basic?.beds,
      baths: basic?.baths,
      sqft: basic?.sqFt ?? basic?.lotSize,
      hoa: basic?.hoa ?? basic?.hoaDues,
      yearBuilt: basic?.yearBuilt,
      mlsNumber: basic?.mlsId ?? basic?.mlsNumber,
      description: basic?.remarks ?? basic?.publicRemarks,
      coordinates: basic?.latLong ?? (basic?.lat != null ? { lat: basic.lat, lng: basic.lng } : undefined),
      photos: Array.isArray(basic?.photos) ? basic?.photos?.slice(0, 5).map((p: any) => p?.url ?? p) : undefined,
    };
  }

  async parseSearch(url: string): Promise<Record<string, any>> {
    const result = await fetchHtml(url);
    if ('error' in result) return { error: result.error, url };

    const { html, finalUrl } = result;

    // Try __NEXT_DATA__
    const nextData = extractNextData(html);
    if (nextData) {
      try {
        const props = nextData?.props?.pageProps;
        const homes = props?.initialRedfin?.searchList?.homes ??
                      props?.homes ??
                      props?.initialRedfin?.mapState?.homes;
        if (Array.isArray(homes) && homes.length > 0) {
          const properties = homes.map((h: any) => {
            const info = h?.homeData?.homeInfo ?? h?.homeInfo ?? h;
            return {
              address: [info?.streetLine, info?.city, info?.state, info?.zip].filter(Boolean).join(', '),
              price: info?.price,
              beds: info?.beds,
              baths: info?.baths,
              sqft: info?.sqFt,
              url: info?.url ? `https://www.redfin.com${info.url}` : undefined,
            };
          });
          return { url: finalUrl, count: properties.length, properties };
        }
      } catch {}
    }

    // DOM fallback
    const $ = cheerio.load(html);
    const properties: any[] = [];
    $('.HomeCardContainer, [data-rf-test-name="mapHomeCard"]').each((_i, el) => {
      const card = $(el);
      properties.push({
        address: card.find('.homeAddressV2, .home-address').text().trim(),
        price: card.find('.price, .homePriceV2').first().text().trim(),
        beds: card.find('.beds').first().text().trim(),
        baths: card.find('.baths').first().text().trim(),
        sqft: card.find('.sqft').first().text().trim(),
        url: (() => {
          const href = card.find('a').first().attr('href');
          return href ? `https://www.redfin.com${href}` : undefined;
        })(),
      });
    });

    if (properties.length === 0) {
      return { error: 'Could not extract search results (page may require JS rendering). Try a zipcode URL: redfin.com/zipcode/{zip}', url: finalUrl };
    }

    return { url: finalUrl, count: properties.length, properties };
  }

  async propertyReport(address: string): Promise<Record<string, any>> {
    const warnings: string[] = [];

    // 1. Geocode — strip unit number first
    const geocodeAddr = address
      .replace(/\s*(?:#|apt\.?\s*|unit\s*|suite\s*)\S+/gi, '')
      .replace(/^,+\s*/, '')
      .trim();

    const geocodeResult = await fetchJson<any[]>(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(geocodeAddr)}&format=json&limit=1`
    );
    if ('error' in geocodeResult || !Array.isArray(geocodeResult) || geocodeResult.length === 0) {
      return { address, warning: `Could not geocode address: ${geocodeAddr}` };
    }

    const lat = parseFloat(geocodeResult[0].lat);
    const lng = parseFloat(geocodeResult[0].lon);
    const report: Record<string, any> = {
      address,
      coordinates: { lat: Math.round(lat * 100000) / 100000, lng: Math.round(lng * 100000) / 100000 },
    };

    // 2. Overpass: buildings (80m) + major roads (80m)
    const areaQuery = `[out:json];\n(\n  way(around:80,${lat.toFixed(6)},${lng.toFixed(6)})[highway][highway!~"footway|path|cycleway|service|steps|pedestrian"];\n  way["building"](around:80,${lat.toFixed(6)},${lng.toFixed(6)});\n);\nout geom tags;`;
    const areaData = await overpassPost(areaQuery);

    const allWays: any[] = areaData?.elements ?? [];
    const buildings = allWays.filter((w: any) => w.tags?.['building']);
    let roads = allWays.filter((w: any) => w.tags?.['highway']);

    // If no roads found nearby, widen to 150m
    if (roads.length === 0) {
      const roadsQuery = `[out:json];\nway(around:150,${lat.toFixed(6)},${lng.toFixed(6)})[highway][highway!~"footway|path|cycleway|service|steps|pedestrian"];\nout geom tags;`;
      const roadsData = await overpassPost(roadsQuery);
      roads = roadsData?.elements ?? [];
    }

    // 3. Nearest road → street info + street bearing
    const road = nearestRoadSegment(lat, lng, roads);
    if (road) {
      report.street = road.street || extractStreet(address);
      report.street_type = road.streetType;
      report.bearing_degrees = road.bearingDeg;
    } else {
      report.street = extractStreet(address);
      warnings.push('No road segment found near address');
    }

    // 4. Subject building height
    const targetStreet = (report.street as string).toLowerCase();
    // Find the building most likely to be the subject (one overlapping the geocoded point)
    let subjectBuilding: any = null;
    for (const b of buildings) {
      // Simple centroid proximity check
      const nodes: { lat: number; lon: number }[] = b.geometry ?? [];
      if (nodes.length < 3) continue;
      const cLat = nodes.reduce((s: number, n: any) => s + n.lat, 0) / nodes.length;
      const cLng = nodes.reduce((s: number, n: any) => s + n.lon, 0) / nodes.length;
      if (haversineM(lat, lng, cLat, cLng) < 30) {
        subjectBuilding = b;
        break;
      }
    }

    const { heightM: subjectHeightM, estimated: subjectHeightEstimated } =
      subjectBuilding ? parseHeight(subjectBuilding.tags ?? {}) : { heightM: 0, estimated: true };

    if (subjectHeightM > 0) {
      report.subject_height_m = Math.round(subjectHeightM * 10) / 10;
      report.subject_height_estimated = subjectHeightEstimated;
    }

    // 5. Unit floor + facing
    const { floor, facing } = parseUnit(address);
    if (floor != null) {
      report.unit_floor = floor;
      report.unit_floor_estimated = false;
    } else if (subjectHeightM > 0) {
      // Estimate from height (assume ground = floor 1)
      report.unit_floor = Math.ceil(subjectHeightM / FLOOR_HEIGHT_M);
      report.unit_floor_estimated = true;
    }
    if (facing) {
      report.unit_facing = facing;
      report.unit_facing_known = true;
    } else {
      report.unit_facing_known = false;
    }

    // 6. Side obstruction analysis
    const streetBearing = road?.bearingDeg ?? 0;
    const sides: Record<string, number> = {
      front: streetBearing,
      rear:  (streetBearing + 180) % 360,
      left:  (streetBearing + 270) % 360,
      right: (streetBearing + 90)  % 360,
    };

    const otherBuildings = buildings.filter((b: any) => b !== subjectBuilding);
    const sideResults: Record<string, any> = {};

    for (const [side, bearing] of Object.entries(sides)) {
      const nearest = nearestBuildingInDir(lat, lng, bearing, otherBuildings);
      const info: Record<string, any> = { direction: toCardinal(bearing) };
      if (nearest) {
        info.open_distance_m = Math.round(nearest.distM);
        const effectiveDist = Math.max(nearest.distM, BLOCKS_LIGHT_DIST_M);
        info.blocks_light = (nearest.heightM / effectiveDist) > BLOCKS_LIGHT_TAN;
        if (info.blocks_light) {
          info.obstruction_height_m = Math.round(nearest.heightM * 10) / 10;
          info.height_estimated = nearest.heightEstimated;
        }
      } else {
        info.open = true;
      }
      // unit_has_windows: true if facing this side (known facing) or if no facing known (all sides possible)
      info.unit_has_windows = !facing || facing === toCardinal(bearing) ||
        (facing.length === 2 && (facing.includes(toCardinal(bearing)[0] ?? '') || facing.includes(toCardinal(bearing)[1] ?? '')));
      sideResults[side] = info;
    }
    report.front = sideResults['front'];
    report.rear  = sideResults['rear'];
    report.left  = sideResults['left'];
    report.right = sideResults['right'];

    // 7. Corner detection
    if (subjectBuilding) {
      const nodes: { lat: number; lon: number }[] = subjectBuilding.geometry ?? [];
      // Check if subject point is near a corner of its building polygon
      let minCornerDist = Infinity;
      for (const node of nodes) {
        const d = haversineM(lat, lng, node.lat, node.lon);
        if (d < minCornerDist) minCornerDist = d;
      }
      if (minCornerDist < 15) {
        // Find which two sides meet at that corner
        report.corner_side = `${toCardinal(sides['left']!)}/${toCardinal(sides['front']!)}`;
      }
    }

    // 8. Overpass: amenities, transit, parks (500-600m)
    const nbQuery = [
      `[out:json];`,
      `(`,
      `  node(around:600,${lat.toFixed(6)},${lng.toFixed(6)})[highway=bus_stop];`,
      `  node(around:600,${lat.toFixed(6)},${lng.toFixed(6)})[public_transport=stop_position];`,
      `  node(around:600,${lat.toFixed(6)},${lng.toFixed(6)})[railway~"station|subway_entrance|tram_stop"];`,
      `  node(around:500,${lat.toFixed(6)},${lng.toFixed(6)})[amenity~"supermarket|grocery|pharmacy|cafe|restaurant|fast_food|bar|bakery|gym"];`,
      `  node(around:500,${lat.toFixed(6)},${lng.toFixed(6)})[shop~"supermarket|grocery|convenience|chemist|bakery"];`,
      `  way(around:600,${lat.toFixed(6)},${lng.toFixed(6)})[leisure=park];`,
      `  node(around:600,${lat.toFixed(6)},${lng.toFixed(6)})[leisure=park];`,
      `  way(around:100,${lat.toFixed(6)},${lng.toFixed(6)})[highway=service][service=alley];`,
      `);`,
      `out center tags;`,
    ].join('\n');

    const nbData = await overpassPost(nbQuery);
    const nbElements: any[] = nbData?.elements ?? [];

    const amenities: Record<string, string[]> = {};
    const transitStops: string[] = [];
    const parks: string[] = [];
    let alleyBehind = false;
    let nearestTransit: { name: string; type: string; distM: number } | null = null;
    let nearestPark: { name: string; distM: number } | null = null;

    for (const el of nbElements) {
      const tags = el.tags ?? {};
      const elLat = el.lat ?? el.center?.lat;
      const elLng = el.lon ?? el.center?.lon;
      const distM = elLat != null ? Math.round(haversineM(lat, lng, elLat, elLng)) : null;

      if (tags['highway'] === 'service' && tags['service'] === 'alley') {
        alleyBehind = true;
        continue;
      }

      if (tags['highway'] === 'bus_stop' || tags['public_transport'] === 'stop_position') {
        const name = tags['name'] ?? 'bus stop';
        transitStops.push(name);
        if (distM != null && (nearestTransit == null || distM < nearestTransit.distM)) {
          nearestTransit = { name, type: 'bus', distM };
        }
        continue;
      }

      if (tags['railway']) {
        const name = tags['name'] ?? tags['railway'];
        transitStops.push(name);
        if (distM != null && (nearestTransit == null || distM < nearestTransit.distM)) {
          nearestTransit = { name, type: tags['railway'], distM };
        }
        continue;
      }

      if (tags['leisure'] === 'park') {
        const name = tags['name'] ?? 'unnamed park';
        parks.push(name);
        if (distM != null && (nearestPark == null || distM < nearestPark.distM)) {
          nearestPark = { name, distM };
        }
        continue;
      }

      // Amenity/shop
      const rawType = tags['amenity'] ?? tags['shop'];
      if (rawType) {
        const cat = AMENITY_CATEGORIES[rawType] ?? rawType;
        const name = tags['name'] ?? rawType;
        if (!amenities[cat]) amenities[cat] = [];
        amenities[cat]!.push(name);
      }
    }

    const neighborhood: string[] = [];
    for (const [cat, names] of Object.entries(amenities)) {
      neighborhood.push(`${cat}: ${names.slice(0, 3).join(', ')}`);
    }
    if (parks.length > 0) neighborhood.push(`parks: ${parks.slice(0, 3).join(', ')}`);
    if (transitStops.length > 0) neighborhood.push(`transit: ${transitStops.slice(0, 3).join(', ')}`);

    if (neighborhood.length > 0) report.neighborhood = neighborhood.join('; ');
    if (nearestTransit) report.nearest_transit = `${nearestTransit.name} (${nearestTransit.type}, ${nearestTransit.distM}m)`;
    if (nearestPark) report.nearest_park = `${nearestPark.name} (${nearestPark.distM}m)`;
    if (alleyBehind) report.alley_behind = true;

    // Sun exposure summary — sides with windows where light is not blocked
    const exposedDirs: string[] = [];
    for (const [, info] of Object.entries(sideResults)) {
      if (info.unit_has_windows && (info.open || !info.blocks_light)) {
        exposedDirs.push(info.direction);
      }
    }
    report.sun_exposure = exposedDirs.length > 0
      ? `Good ${exposedDirs.join('/')} exposure`
      : 'Limited — all window-facing sides are obstructed';

    // 9. Elevation (USGS, in meters)
    const elevResult = await fetchJson<any>(
      `https://epqs.nationalmap.gov/v1/json?x=${lng}&y=${lat}&wkid=4326&includeDate=false`
    );
    if (!('error' in elevResult) && elevResult?.value != null) {
      const elevFt = parseFloat(elevResult.value);
      report.elevation_m = Math.round(elevFt * 0.3048 * 10) / 10; // USGS returns feet
    }

    // 10. Flood zone (FEMA)
    const femaResult = await fetchJson<any>(
      `https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL/MapServer/28/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,ZONE_SUBTY&returnGeometry=false&f=json`
    );
    if (!('error' in femaResult)) {
      const features = femaResult?.features;
      if (Array.isArray(features) && features.length > 0) {
        const zone = features[0]?.attributes?.FLD_ZONE;
        const sub = features[0]?.attributes?.ZONE_SUBTY;
        report.flood_zone = sub ? `${zone} (${sub})` : zone;
      }
    }

    if (warnings.length > 0) report.warnings = warnings;
    return report;
  }
}
