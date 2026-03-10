package com.lifeos.tools;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.*;
import java.util.regex.Pattern;

/**
 * Parse Redfin listing and search/neighborhood pages into structured JSON.
 */
@Component
public class Redfin {

    private static final String USER_AGENT =
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    private final HttpClient httpClient = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();
    private final ObjectMapper mapper = new ObjectMapper();

    public Map<String, Object> parseListing(String url) {
        if (!url.startsWith("http://") && !url.startsWith("https://"))
            return Map.of("error", "URL must start with http:// or https://");
        if (!url.contains("redfin.com"))
            return Map.of("error", "URL must be a redfin.com listing");

        String html;
        try {
            html = fetch(url);
        } catch (Exception e) {
            return Map.of("error", "Failed to fetch listing: " + e.getMessage());
        }

        var ld = extractJsonLd(html, false);
        var entity = mapOf(ld.get("mainEntity"));
        var addr = mapOf(entity.get("address"));
        var geo = mapOf(entity.get("geo"));
        var offers = mapOf(ld.get("offers"));
        var floorSize = mapOf(entity.get("floorSize"));

        var price = toDouble(offers.get("price"));
        var sqFt = toDouble(floorSize.get("value"));
        var beds = toDouble(entity.get("numberOfBedrooms"));
        var baths = toDouble(entity.get("numberOfBathroomsTotal"));
        var yearBuilt = entity.get("yearBuilt");
        var propType = firstNonNull(entity.get("accommodationCategory"), entity.get("@type"));
        var description = str(ld.getOrDefault("description", "")).strip();
        var datePosted = str(ld.getOrDefault("datePosted", ""));
        var dateListed = datePosted.length() >= 10 ? datePosted.substring(0, 10) : null;

        var amenities = new ArrayList<String>();
        if (entity.get("amenityFeature") instanceof List<?> feats) {
            for (var f : feats) {
                if (f instanceof Map<?, ?> fm && Boolean.TRUE.equals(fm.get("value")))
                    amenities.add(str(fm.get("name")));
            }
        }

        var images = new ArrayList<String>();
        if (entity.get("image") instanceof List<?> imgs) {
            for (var img : imgs) {
                if (img instanceof Map<?, ?> im && im.get("url") != null)
                    images.add(str(im.get("url")));
            }
        }

        // Supplementary regex fields
        var hoaMatch = Pattern.compile("(\\$[\\d,]+)/mo</span><span[^>]*>HOA Dues").matcher(html);
        Integer hoaMonthly = hoaMatch.find() ? parseIntStr(hoaMatch.group(1)) : null;

        var mlsMatch = Pattern.compile("MLS#\\s*([A-Z0-9]+)").matcher(html);
        String mlsNumber = mlsMatch.find() ? mlsMatch.group(1) : null;

        var domMatch = Pattern.compile("(\\d+)\\s*[Dd]ays?\\s*on\\s*[Mm]arket").matcher(html);
        Integer daysOnMarket = domMatch.find() ? Integer.parseInt(domMatch.group(1)) : null;

        var taxMatch = Pattern.compile("[Aa]nnual [Tt]ax[^\"]*\",\"content\":\"(\\$[\\d,]+)").matcher(html);
        Integer taxesAnnual = taxMatch.find() ? parseIntStr(taxMatch.group(1)) : null;

        Integer pricePerSqft = (price != null && sqFt != null && sqFt > 0)
                ? (int) Math.round(price / sqFt) : null;

        var result = new LinkedHashMap<String, Object>();
        result.put("url", url);
        result.put("mls_number", mlsNumber);
        result.put("date_listed", dateListed);
        result.put("days_on_market", daysOnMarket);
        result.put("address", Map.of(
                "street", str(addr.get("streetAddress")),
                "city", str(addr.get("addressLocality")),
                "state", str(addr.get("addressRegion")),
                "zip", str(addr.get("postalCode"))));
        result.put("lat", geo.get("latitude"));
        result.put("lon", geo.get("longitude"));
        result.put("price", price != null ? price.intValue() : null);
        result.put("price_per_sqft", pricePerSqft);
        result.put("beds", beds != null ? beds.intValue() : null);
        result.put("baths", baths);
        result.put("sq_ft", sqFt != null ? sqFt.intValue() : null);
        result.put("year_built", yearBuilt);
        result.put("property_type", propType);
        result.put("hoa_monthly", hoaMonthly);
        result.put("taxes_annual", taxesAnnual);
        result.put("amenities", amenities);
        result.put("description", description);
        result.put("images", images);
        return result;
    }

    public Map<String, Object> parseSearch(String url) {
        if (!url.startsWith("http://") && !url.startsWith("https://"))
            return Map.of("error", "URL must start with http:// or https://");
        if (!url.contains("redfin.com"))
            return Map.of("error", "URL must be a redfin.com URL");

        String html;
        try {
            html = fetch(url);
        } catch (Exception e) {
            return Map.of("error", "Failed to fetch page: " + e.getMessage());
        }

        // JSON-LD listing blocks (url, address, geo, sq_ft, property_type)
        var ldListings = new ArrayList<Map<String, Object>>();
        var scriptPat = Pattern.compile(
                "<script type=\"application/ld\\+json\">(.*?)</script>",
                Pattern.DOTALL | Pattern.CASE_INSENSITIVE);
        var scriptMatcher = scriptPat.matcher(html);
        while (scriptMatcher.find()) {
            try {
                var raw = scriptMatcher.group(1).strip();
                var parsed = mapper.readValue(raw, new TypeReference<Object>() {});
                if (parsed instanceof List<?> list && !list.isEmpty()
                        && list.get(0) instanceof Map<?, ?> first
                        && str(first.get("url")).contains("redfin.com")) {
                    @SuppressWarnings("unchecked")
                    var m = (Map<String, Object>) first;
                    ldListings.add(m);
                }
            } catch (Exception ignored) {}
        }

        // Prices from card elements
        var pricesPat = Pattern.compile("bp-Homecard__Price--value\">(\\$[\\d,]+)");
        var pricesMatcher = pricesPat.matcher(html);
        var pricesRaw = new ArrayList<String>();
        while (pricesMatcher.find()) pricesRaw.add(pricesMatcher.group(1));

        // Beds/baths from aria-labels
        var ariaPat = Pattern.compile(
                "aria-label=\"Property at ([^\"]+, \\d+ beds?, [^\"]+)\"");
        var ariaMatcher = ariaPat.matcher(html);
        var ariaLabels = new ArrayList<String>();
        while (ariaMatcher.find()) ariaLabels.add(ariaMatcher.group(1));

        int n = Math.min(ldListings.size(), Math.min(pricesRaw.size(), ariaLabels.size()));
        var listings = new ArrayList<Map<String, Object>>();
        for (int i = 0; i < n; i++) {
            var ld = ldListings.get(i);
            var addr = mapOf(ld.get("address"));
            var geo = mapOf(ld.get("geo"));
            var floorSize = mapOf(ld.get("floorSize"));

            var price = parseIntStr(pricesRaw.get(i));
            var sqFt = toDouble(floorSize.get("value"));
            Integer pricePerSqft = (price != null && sqFt != null && sqFt > 0)
                    ? (int) Math.round(price / sqFt) : null;

            Integer beds = null;
            Double baths = null;
            var ariaLabel = ariaLabels.get(i);
            var bedsMatch = Pattern.compile("(\\d+) beds?").matcher(ariaLabel);
            if (bedsMatch.find()) beds = Integer.parseInt(bedsMatch.group(1));
            var bathsMatch = Pattern.compile("(\\d+(?:\\.\\d+)?) baths?").matcher(ariaLabel);
            if (bathsMatch.find()) {
                baths = Double.parseDouble(bathsMatch.group(1));
                if (baths == baths.intValue()) baths = (double) baths.intValue();
            }

            var entry = new LinkedHashMap<String, Object>();
            entry.put("url", ld.get("url"));
            entry.put("address", Map.of(
                    "street", str(addr.get("streetAddress")),
                    "city", str(addr.get("addressLocality")),
                    "state", str(addr.get("addressRegion")),
                    "zip", str(addr.get("postalCode"))));
            entry.put("lat", geo.get("latitude"));
            entry.put("lon", geo.get("longitude"));
            entry.put("price", price);
            entry.put("price_per_sqft", pricePerSqft);
            entry.put("beds", beds);
            entry.put("baths", baths);
            entry.put("sq_ft", sqFt != null ? sqFt.intValue() : null);
            listings.add(entry);
        }

        return Map.of("url", url, "count", listings.size(), "listings", listings);
    }


    // ── Private ──────────────────────────────────────────────────────────────────

    private String fetch(String url) throws Exception {
        var request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header("User-Agent", USER_AGENT)
                .header("Accept-Language", "en-US,en;q=0.9")
                .timeout(Duration.ofSeconds(15))
                .GET()
                .build();
        var response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() >= 400)
            throw new RuntimeException("HTTP " + response.statusCode());
        return response.body();
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> extractJsonLd(String html, boolean asList) {
        var pat = Pattern.compile(
                "<script type=\"application/ld\\+json\">(.*?)</script>",
                Pattern.DOTALL | Pattern.CASE_INSENSITIVE);
        var m = pat.matcher(html);
        while (m.find()) {
            try {
                var d = mapper.readValue(m.group(1).strip(),
                        new TypeReference<Map<String, Object>>() {});
                var types = d.getOrDefault("@type", List.of());
                if (types instanceof String s) types = List.of(s);
                if (types instanceof List<?> l &&
                        (l.contains("RealEstateListing") || l.contains("Product")))
                    return d;
            } catch (Exception ignored) {}
        }
        return Map.of();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> mapOf(Object o) {
        if (o instanceof Map<?, ?> m) return (Map<String, Object>) m;
        return Map.of();
    }

    private static String str(Object o) {
        return o == null ? "" : o.toString();
    }

    private static Double toDouble(Object o) {
        if (o == null) return null;
        if (o instanceof Number n) return n.doubleValue();
        try { return Double.parseDouble(o.toString()); } catch (Exception e) { return null; }
    }

    private static Integer parseIntStr(String s) {
        if (s == null || s.isEmpty()) return null;
        var cleaned = s.replaceAll("[^\\d]", "");
        return cleaned.isEmpty() ? null : Integer.parseInt(cleaned);
    }

    private static Object firstNonNull(Object a, Object b) {
        return a != null ? a : b;
    }
}
