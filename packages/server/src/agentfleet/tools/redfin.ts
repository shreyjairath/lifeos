import * as cheerio from 'cheerio';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_MS = 20_000;

async function fetchHtml(url: string): Promise<{ html: string; finalUrl: string } | { error: string }> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
    });
    if (response.status >= 400) return { error: `HTTP ${response.status}` };
    const html = await response.text();
    return { html, finalUrl: response.url };
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

function extractNextData(html: string): any | null {
  try {
    const match = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (match?.[1]) return JSON.parse(match[1]);
  } catch {}
  return null;
}

export class Redfin {
  async parseListing(url: string): Promise<Record<string, any>> {
    const result = await fetchHtml(url);
    if ('error' in result) return { error: result.error, url };

    const { html, finalUrl } = result;
    const $ = cheerio.load(html);

    // Try __NEXT_DATA__ first
    const nextData = extractNextData(html);
    if (nextData) {
      try {
        const props = nextData?.props?.pageProps;
        const listing = props?.listing ?? props?.initialRedfin?.listing ?? props?.aboveTheFold?.payload?.homeDetails;
        if (listing) {
          return this.normalizeListingData(listing, finalUrl);
        }
      } catch {}
    }

    // Try window.__property or similar script JSON
    const scriptMatch = html.match(/window\.__property\s*=\s*(\{[\s\S]*?\});/) ??
                        html.match(/window\.listingData\s*=\s*(\{[\s\S]*?\});/);
    if (scriptMatch?.[1]) {
      try {
        const data = JSON.parse(scriptMatch[1]);
        return this.normalizeListingData(data, finalUrl);
      } catch {}
    }

    // Fall back to DOM parsing
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
      photos: Array.isArray(basic?.photos) ? basic.photos.slice(0, 5).map((p: any) => p?.url ?? p) : undefined,
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

    // Fall back to DOM parsing of property cards
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
    const report: Record<string, any> = { address };

    // 1. Geocode via Nominatim
    const geocodeUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&addressdetails=1`;
    const geocodeResult = await fetchJson<any[]>(geocodeUrl);
    if ('error' in geocodeResult || !Array.isArray(geocodeResult) || geocodeResult.length === 0) {
      return { error: 'Could not geocode address', address };
    }

    const { lat, lon: lng, display_name } = geocodeResult[0];
    report.coordinates = { lat: parseFloat(lat), lng: parseFloat(lng) };
    report.formattedAddress = display_name;

    // 2. Elevation via USGS
    const elevResult = await fetchJson<any>(
      `https://epqs.nationalmap.gov/v1/json?x=${lng}&y=${lat}&wkid=4326&includeDate=false`
    );
    if (!('error' in elevResult)) {
      const elevFt = elevResult?.value;
      if (elevFt != null) report.elevationFt = Math.round(parseFloat(elevFt));
    }

    // 3. FEMA flood zone via FEMA ArcGIS
    const femaResult = await fetchJson<any>(
      `https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL/MapServer/28/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,ZONE_SUBTY&f=json`
    );
    if (!('error' in femaResult)) {
      const features = femaResult?.features;
      if (Array.isArray(features) && features.length > 0) {
        const zone = features[0]?.attributes?.FLD_ZONE;
        const subtype = features[0]?.attributes?.ZONE_SUBTY;
        report.floodZone = subtype ? `${zone} (${subtype})` : zone;
        report.floodRisk = zone?.startsWith('A') || zone?.startsWith('V') ? 'High — Special Flood Hazard Area' :
                           zone === 'X' ? 'Minimal' : 'Moderate';
      } else {
        report.floodZone = 'Not determined';
      }
    }

    // 4. Walk Score via their public API (no key needed for basic lookup)
    const walkUrl = `https://www.walkscore.com/score/loc/lat=${lat}/lng=${lng}/`;
    const walkResult = await fetchHtml(walkUrl);
    if (!('error' in walkResult)) {
      const wsMatch = walkResult.html.match(/"walkscore"\s*:\s*(\d+)/);
      const tsMatch = walkResult.html.match(/"transit"\s*:\s*\{[^}]*"score"\s*:\s*(\d+)/);
      const bsMatch = walkResult.html.match(/"bike"\s*:\s*\{[^}]*"score"\s*:\s*(\d+)/);
      if (wsMatch?.[1]) report.walkScore = parseInt(wsMatch[1]);
      if (tsMatch?.[1]) report.transitScore = parseInt(tsMatch[1]);
      if (bsMatch?.[1]) report.bikeScore = parseInt(bsMatch[1]);
    }

    return report;
  }
}
