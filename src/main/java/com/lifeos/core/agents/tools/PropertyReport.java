package com.lifeos.core.agents.tools;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.regex.Pattern;

/**
 * Property report: sun exposure, street orientation, building obstructions,
 * unit floor/facing, and neighborhood data (transit, walkability, parks,
 * flood zone, elevation) using OSM Overpass + Nominatim + FEMA + OpenTopoData.
 */
@Component
public class PropertyReport {

    private static final String NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
    private static final List<String> OVERPASS_MIRRORS = List.of(
            "https://overpass-api.de/api/interpreter",
            "https://overpass.kumi.systems/api/interpreter",
            "https://overpass.openstreetmap.fr/api/interpreter"
    );
    private static final String USER_AGENT = "lifeos-agent/1.0";
    private static final double BLOCKS_LIGHT_DIST_M = 8.0;
    private static final double BLOCKS_LIGHT_TAN = Math.tan(Math.toRadians(20));
    private static final double FLOOR_HEIGHT_M = 3.5;

    private static final Map<String, Double> BUILDING_TYPE_HEIGHTS = Map.ofEntries(
            Map.entry("bungalow", 3.5), Map.entry("shed", 3.0), Map.entry("garage", 3.0),
            Map.entry("garages", 3.0), Map.entry("carport", 3.0), Map.entry("roof", 3.0),
            Map.entry("house", 6.0), Map.entry("detached", 6.0), Map.entry("semidetached_house", 6.0),
            Map.entry("terrace", 7.0), Map.entry("residential", 9.0), Map.entry("apartments", 10.5),
            Map.entry("dormitory", 10.5), Map.entry("hotel", 12.0), Map.entry("commercial", 10.5),
            Map.entry("retail", 5.0), Map.entry("office", 12.0), Map.entry("industrial", 8.0),
            Map.entry("warehouse", 8.0), Map.entry("school", 9.0), Map.entry("university", 10.5),
            Map.entry("church", 14.0), Map.entry("cathedral", 20.0), Map.entry("civic", 10.5),
            Map.entry("public", 9.0), Map.entry("yes", 7.0)
    );

    private static final Map<String, String> HIGHWAY_LABELS = Map.of(
            "motorway", "highway", "trunk", "trunk road", "primary", "major arterial",
            "secondary", "secondary arterial", "tertiary", "minor collector",
            "unclassified", "local road", "residential", "residential street",
            "living_street", "living street", "service", "service road"
    );

    private static final Map<String, String> AMENITY_CATEGORIES = Map.ofEntries(
            Map.entry("supermarket", "grocery"), Map.entry("grocery", "grocery"),
            Map.entry("pharmacy", "pharmacy"), Map.entry("chemist", "pharmacy"),
            Map.entry("cafe", "cafe"), Map.entry("coffee", "cafe"),
            Map.entry("restaurant", "restaurant"), Map.entry("fast_food", "restaurant"),
            Map.entry("bar", "bar"), Map.entry("pub", "bar"),
            Map.entry("bakery", "bakery"), Map.entry("gym", "gym"),
            Map.entry("fitness_centre", "gym")
    );

    private static final Map<String, String> DIR_ALIASES = Map.ofEntries(
            Map.entry("n", "N"), Map.entry("north", "N"),
            Map.entry("s", "S"), Map.entry("south", "S"),
            Map.entry("e", "E"), Map.entry("east", "E"),
            Map.entry("w", "W"), Map.entry("west", "W"),
            Map.entry("ne", "NE"), Map.entry("northeast", "NE"),
            Map.entry("nw", "NW"), Map.entry("northwest", "NW"),
            Map.entry("se", "SE"), Map.entry("southeast", "SE"),
            Map.entry("sw", "SW"), Map.entry("southwest", "SW")
    );

    private final HttpClient httpClient = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();
    private final ObjectMapper mapper = new ObjectMapper();

    // ── Public entry point ────────────────────────────────────────────────────

    public Map<String, Object> report(String address) {
        var warnings = new ArrayList<String>();

        // 1. Geocode
        double lat, lon;
        try {
            var geocodeAddress = address.replaceAll(
                    "(?i)\\s*(?:#|apt\\.?\\s*|unit\\s*|suite\\s*)\\S+", "").strip().replaceAll("^,+\\s*", "");
            var coords = geocode(geocodeAddress);
            lat = coords[0]; lon = coords[1];
        } catch (Exception e) {
            return Map.of("address", address, "warning", "Geocoding failed: " + e.getMessage());
        }

        // 2. OSM roads + buildings
        List<Map<String, Object>> roads, buildings;
        try {
            var area = queryArea(lat, lon, 80);
            roads = area.get(0);
            buildings = area.get(1);
        } catch (Exception e) {
            return linkedMap(
                    "address", address,
                    "coordinates", List.of(round5(lat), round5(lon)),
                    "warning", "OSM query failed: " + e.getMessage()
            );
        }

        // 3. Street bearing
        var targetStreet = extractStreet(address);
        String streetName = "unknown"; double streetBearing = 0, frontBearing = 0;
        String highwayType = "unknown";
        try {
            var seg = nearestRoadSegment(lat, lon, roads, targetStreet);
            streetName = (String) seg[0]; streetBearing = (double) seg[1];
            frontBearing = (double) seg[2]; highwayType = (String) seg[3];
        } catch (Exception e) {
            warnings.add("Street bearing failed: " + e.getMessage());
        }
        double rearBearing = (frontBearing + 180) % 360;
        double leftBearing = (frontBearing - 90 + 360) % 360;
        double rightBearing = (frontBearing + 90) % 360;

        // 4. Subject building + unit floor
        var subjectId = findSubjectBuildingId(lat, lon, buildings);
        var subjectBld = buildings.stream().filter(b -> Objects.equals(b.get("id"), subjectId)).findFirst().orElse(null);
        var subjectHeightResult = parseHeight(tags(subjectBld));
        double subjectHeight = subjectHeightResult[0]; boolean subjectHeightEst = subjectHeightResult[1] != 0;

        var unitInfo = parseUnit(address);
        int floor = (int) unitInfo[0]; boolean floorEst = !Integer.valueOf(0).equals(unitInfo[1]);
        String unitFacing = (String) unitInfo[2]; boolean facingKnown = !Integer.valueOf(0).equals(unitInfo[3]);
        double eyeHeightM = (floor - 1) * FLOOR_HEIGHT_M;

        // 5. Side distances
        var allSides = new LinkedHashMap<String, Map<String, Object>>();
        for (var entry : List.of(
                new double[]{frontBearing, 1}, new double[]{rearBearing, 0},
                new double[]{leftBearing, 0}, new double[]{rightBearing, 0}
        )) {
            double bearing = entry[0]; boolean isFront = entry[1] != 0;
            try {
                allSides.put(toCardinal(bearing), sideInfo(lat, lon, bearing, buildings, isFront, subjectId, subjectBld, eyeHeightM));
            } catch (Exception e) {
                warnings.add(e.getMessage());
                allSides.put(toCardinal(bearing), Map.of("direction", toCardinal(bearing), "open", false, "open_distance_m", 0.0, "blocks_light", false));
            }
        }

        // Annotate unit_has_windows
        for (var entry : allSides.entrySet()) {
            entry.getValue().put("unit_has_windows", hasWindows(entry.getKey(), unitFacing));
        }

        // 6. Corner check
        Map<String, Object> cornerSide = null;
        try {
            cornerSide = checkCorner(lat, lon, roads, streetBearing, frontBearing, buildings, subjectId, subjectBld);
        } catch (Exception e) {
            warnings.add("Corner check failed: " + e.getMessage());
        }

        // 7. Neighborhood (best-effort)
        var neighborhood = new LinkedHashMap<String, Object>();
        try {
            var nbElements = queryNeighborhood(lat, lon);
            neighborhood.putAll(buildNeighborhood(nbElements, lat, lon));
        } catch (Exception e) {
            warnings.add("Neighborhood query failed: " + e.getMessage());
        }
        try { neighborhood.put("flood_zone", fetchFloodZone(lat, lon)); } catch (Exception e) { neighborhood.put("flood_zone", null); }
        try { neighborhood.put("elevation_m", fetchElevation(lat, lon)); } catch (Exception e) { neighborhood.put("elevation_m", null); }

        var result = new LinkedHashMap<String, Object>();
        result.put("address", address);
        result.put("coordinates", List.of(round5(lat), round5(lon)));
        result.put("street", streetName);
        result.put("street_type", HIGHWAY_LABELS.getOrDefault(highwayType, highwayType));
        result.put("bearing_degrees", Math.round(streetBearing * 10) / 10.0);
        result.put("subject_height_m", subjectHeight > 0 ? Math.round(subjectHeight * 10) / 10.0 : null);
        result.put("subject_height_estimated", subjectHeight > 0 ? subjectHeightEst : null);
        result.put("unit_floor", floor);
        result.put("unit_floor_estimated", floorEst);
        result.put("unit_facing", unitFacing);
        result.put("unit_facing_known", facingKnown);
        result.put("front", allSides.get(toCardinal(frontBearing)));
        result.put("rear", allSides.get(toCardinal(rearBearing)));
        result.put("left", allSides.get(toCardinal(leftBearing)));
        result.put("right", allSides.get(toCardinal(rightBearing)));
        result.put("corner_side", cornerSide);
        result.put("neighborhood", neighborhood);
        result.put("warning", warnings.isEmpty() ? null : String.join("; ", warnings));
        return result;
    }


    // ── Geo helpers ───────────────────────────────────────────────────────────

    private static double haversine(double lat1, double lon1, double lat2, double lon2) {
        double R = 6371000, phi1 = Math.toRadians(lat1), phi2 = Math.toRadians(lat2);
        double dphi = Math.toRadians(lat2 - lat1), dlambda = Math.toRadians(lon2 - lon1);
        double a = Math.pow(Math.sin(dphi / 2), 2) + Math.cos(phi1) * Math.cos(phi2) * Math.pow(Math.sin(dlambda / 2), 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    private static double bearing(double lat1, double lon1, double lat2, double lon2) {
        double dlon = Math.toRadians(lon2 - lon1), lat1r = Math.toRadians(lat1), lat2r = Math.toRadians(lat2);
        double x = Math.sin(dlon) * Math.cos(lat2r);
        double y = Math.cos(lat1r) * Math.sin(lat2r) - Math.sin(lat1r) * Math.cos(lat2r) * Math.cos(dlon);
        return (Math.toDegrees(Math.atan2(x, y)) + 360) % 360;
    }

    private static String toCardinal(double b) {
        return new String[]{"N", "NE", "E", "SE", "S", "SW", "W", "NW"}[(int) Math.round(b / 45) % 8];
    }

    private static boolean pointLeftOfSeg(double px, double py, double ax, double ay, double bx, double by) {
        return ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) > 0;
    }

    private static boolean pointInPolygon(double lat, double lon, List<double[]> nodes) {
        boolean inside = false;
        int j = nodes.size() - 1;
        for (int i = 0; i < nodes.size(); i++) {
            double latI = nodes.get(i)[0], lonI = nodes.get(i)[1];
            double latJ = nodes.get(j)[0], lonJ = nodes.get(j)[1];
            if ((latI > lat) != (latJ > lat) &&
                    lon < (lonJ - lonI) * (lat - latI) / (latJ - latI) + lonI) {
                inside = !inside;
            }
            j = i;
        }
        return inside;
    }

    // ── Unit parsing ──────────────────────────────────────────────────────────

    /** Returns [floor, floorEstimated (0/1), facing (String or null), facingKnown (0/1)] */
    private Object[] parseUnit(String address) {
        var m = Pattern.compile("(?i)(?:#|apt\\.?\\s*|unit\\s*|suite\\s*)([A-Za-z0-9][-A-Za-z0-9]*)").matcher(address);
        if (!m.find()) return new Object[]{1, 0, null, 0};
        var unit = m.group(1).replaceAll("^-+|-+$", "");

        var dm = Pattern.compile("^(\\d+)-?([A-Za-z]+)$").matcher(unit);
        if (dm.matches()) {
            int floor = Math.max(1, Character.getNumericValue(dm.group(1).charAt(0)));
            var facing = DIR_ALIASES.get(dm.group(2).toLowerCase());
            return facing != null ? new Object[]{floor, 1, facing, 1} : new Object[]{floor, 1, null, 0};
        }
        var dm2 = Pattern.compile("^(\\d+)$").matcher(unit);
        if (dm2.matches()) {
            int floor = Math.max(1, Character.getNumericValue(dm2.group(1).charAt(0)));
            return new Object[]{floor, 1, null, 0};
        }
        return new Object[]{1, 1, null, 0};
    }

    private static String extractStreet(String address) {
        var part = address.split(",")[0].strip();
        part = part.replaceAll("^\\d+\\s*", "");
        return part.toLowerCase().strip();
    }

    private static boolean namesMatch(String osmName, String targetStreet) {
        var ignore = Set.of("n", "s", "e", "w", "north", "south", "east", "west",
                "st", "ave", "blvd", "dr", "rd", "pl", "ct", "ln", "way",
                "street", "avenue", "boulevard", "drive", "road", "place");
        var sigWords = (java.util.function.Function<String, Set<String>>) s -> {
            var words = new HashSet<String>();
            for (var w : s.toLowerCase().replaceAll("[^a-z0-9 ]", "").split("\\s+")) {
                if (!ignore.contains(w) && !w.isEmpty()) words.add(w);
            }
            return words;
        };
        var a = sigWords.apply(osmName);
        var b = sigWords.apply(targetStreet);
        return a.stream().anyMatch(b::contains);
    }

    // ── Building helpers ──────────────────────────────────────────────────────

    private Object findSubjectBuildingId(double lat, double lon, List<Map<String, Object>> buildings) {
        for (var bld : buildings) {
            var nodes = geometry(bld);
            if (nodes.size() >= 3 && pointInPolygon(lat, lon, nodes)) return bld.get("id");
        }
        Object bestId = null; double bestDist = Double.MAX_VALUE;
        for (var bld : buildings) {
            for (var n : geometry(bld)) {
                double d = haversine(lat, lon, n[0], n[1]);
                if (d < bestDist) { bestDist = d; bestId = bld.get("id"); }
            }
        }
        return bestDist <= 20 ? bestId : null;
    }

    /** Returns [heightM, isEstimated (0.0/1.0)]. heightM is 0.0 when unknown. */
    private static double[] parseHeight(Map<String, Object> tagsMap) {
        if (tagsMap.containsKey("height")) {
            try {
                return new double[]{Double.parseDouble(tagsMap.get("height").toString().replace("m", "").strip()), 0};
            } catch (Exception ignored) {}
        }
        if (tagsMap.containsKey("building:levels")) {
            try {
                return new double[]{Double.parseDouble(tagsMap.get("building:levels").toString()) * 3.5, 0};
            } catch (Exception ignored) {}
        }
        var btype = tagsMap.getOrDefault("building", "").toString().toLowerCase();
        var h = BUILDING_TYPE_HEIGHTS.get(btype);
        return h != null ? new double[]{h, 1} : new double[]{0, 1};
    }

    private double[] buildingEdgeInDirection(double lat, double lon, double bearingDeg, Map<String, Object> bld) {
        var nodes = bld != null ? geometry(bld) : List.<double[]>of();
        if (nodes.isEmpty()) return new double[]{lat, lon};
        double bearingR = Math.toRadians(bearingDeg), cosLat = Math.cos(Math.toRadians(lat));
        double bestProj = Double.NEGATIVE_INFINITY; double[] best = {lat, lon};
        for (var n : nodes) {
            double dlat = (n[0] - lat) * 111000, dlon = (n[1] - lon) * 111000 * cosLat;
            double proj = dlon * Math.sin(bearingR) + dlat * Math.cos(bearingR);
            if (proj > bestProj) { bestProj = proj; best = n; }
        }
        return best;
    }

    // ── Ray-segment intersection ──────────────────────────────────────────────

    private static Double raySegmentIntersect(double ox, double oy, double dx, double dy,
                                              double ax, double ay, double bx, double by) {
        double ex = bx - ax, ey = by - ay;
        double denom = dx * ey - dy * ex;
        if (Math.abs(denom) < 1e-12) return null;
        double t = ((ax - ox) * ey - (ay - oy) * ex) / denom;
        double s = ((ax - ox) * dy - (ay - oy) * dx) / denom;
        return (t >= 0 && s >= 0 && s <= 1) ? t : null;
    }

    private record NearestBuilding(double distM, double heightM, boolean heightEstimated) {}

    private NearestBuilding nearestBuildingInDirection(double lat, double lon, double bearing,
                                                       List<Map<String, Object>> buildings,
                                                       double coneDeg, double maxM, Object excludeId) {
        double bearingR = Math.toRadians(bearing);
        double dx = Math.sin(bearingR), dy = Math.cos(bearingR);
        double cosLat = Math.cos(Math.toRadians(lat));

        double bestDist = maxM; double bestHeight = 0; boolean bestEst = true;

        for (var bld : buildings) {
            if (excludeId != null && excludeId.equals(bld.get("id"))) continue;
            var nodes = geometry(bld);
            if (nodes.size() < 2) continue;
            var t = tags(bld);

            double cLat = nodes.stream().mapToDouble(n -> n[0]).average().orElse(lat);
            double cLon = nodes.stream().mapToDouble(n -> n[1]).average().orElse(lon);
            double cBearing = bearing(lat, lon, cLat, cLon);
            double angleDiff = Math.abs(((cBearing - bearing + 180) % 360) - 180);
            if (angleDiff > coneDeg + 45) continue;

            for (int i = 0; i < nodes.size(); i++) {
                double ax = (nodes.get(i)[1] - lon) * 111000 * cosLat;
                double ay = (nodes.get(i)[0] - lat) * 111000;
                int j = (i + 1) % nodes.size();
                double bx = (nodes.get(j)[1] - lon) * 111000 * cosLat;
                double by = (nodes.get(j)[0] - lat) * 111000;
                var hit = raySegmentIntersect(0, 0, dx, dy, ax, ay, bx, by);
                if (hit == null || hit > bestDist) continue;
                double hitX = dx * hit, hitY = dy * hit;
                double hitBearing = (Math.toDegrees(Math.atan2(hitX, hitY)) + 360) % 360;
                double hitAngle = Math.abs(((hitBearing - bearing + 180) % 360) - 180);
                if (hitAngle > coneDeg) continue;
                bestDist = hit;
                var h = parseHeight(t);
                bestHeight = h[0]; bestEst = h[1] != 0;
            }
        }
        return new NearestBuilding(bestDist, bestHeight, bestEst);
    }

    private Map<String, Object> sideInfo(double lat, double lon, double bearing,
                                          List<Map<String, Object>> buildings, boolean isFront,
                                          Object excludeId, Map<String, Object> subjectBld,
                                          double eyeHeightM) {
        double originLat = lat, originLon = lon;
        if (subjectBld != null) {
            var edge = buildingEdgeInDirection(lat, lon, bearing, subjectBld);
            originLat = edge[0]; originLon = edge[1];
        }
        var nb = nearestBuildingInDirection(originLat, originLon, bearing, buildings, 45, 80, excludeId);
        boolean open = nb.distM() > BLOCKS_LIGHT_DIST_M;

        boolean blocks;
        if (isFront) {
            blocks = false;
        } else if (nb.heightM() > 0) {
            double effectiveH = nb.heightM() - eyeHeightM;
            blocks = effectiveH > 0 && (effectiveH / Math.max(nb.distM(), 0.1)) > BLOCKS_LIGHT_TAN;
        } else {
            blocks = !open;
        }

        var side = new LinkedHashMap<String, Object>();
        side.put("direction", toCardinal(bearing));
        side.put("open", open);
        side.put("open_distance_m", Math.round(nb.distM() * 10) / 10.0);
        side.put("obstruction_height_m", nb.heightM() > 0 ? Math.round(nb.heightM() * 10) / 10.0 : null);
        side.put("height_estimated", nb.heightM() > 0 ? nb.heightEstimated() : null);
        side.put("blocks_light", blocks);
        return side;
    }

    // ── Street bearing ────────────────────────────────────────────────────────

    /** Returns [streetName, streetBearing, frontBearing, highwayType] */
    private Object[] nearestRoadSegment(double lat, double lon, List<Map<String, Object>> roads,
                                        String targetStreet) throws Exception {
        var best = bestSegment(lat, lon, roads, targetStreet);
        Map<String, Object> way = (Map<String, Object>) best[0];
        Object[] seg = (Object[]) best[1];

        // If best way doesn't match targetStreet, try wider radius
        if (targetStreet != null && way != null) {
            var t = tags(way);
            var osmName = t.getOrDefault("name", t.getOrDefault("ref", "")).toString();
            if (!namesMatch(osmName, targetStreet)) {
                var widerRoads = fetchRoads(lat, lon, 200);
                var wider = bestSegment(lat, lon, widerRoads, targetStreet);
                Map<String, Object> ww = (Map<String, Object>) wider[0];
                Object[] ws = (Object[]) wider[1];
                if (ws != null && ww != null) {
                    var wt = tags(ww);
                    var wName = wt.getOrDefault("name", wt.getOrDefault("ref", "")).toString();
                    if (namesMatch(wName, targetStreet)) { way = ww; seg = ws; }
                }
            }
        }

        if (seg == null) throw new Exception("No road segment found near address");
        var a = (Map<String, Object>) seg[0]; var b = (Map<String, Object>) seg[1];
        double aLat = toD(a.get("lat")), aLon = toD(a.get("lon"));
        double bLat = toD(b.get("lat")), bLon = toD(b.get("lon"));
        double streetBearing = bearing(aLat, aLon, bLat, bLon);
        boolean left = pointLeftOfSeg(lon, lat, aLon, aLat, bLon, bLat);
        double frontBearing = left ? (streetBearing + 90) % 360 : (streetBearing - 90 + 360) % 360;
        var t = tags(way);
        return new Object[]{
                t.getOrDefault("name", t.getOrDefault("ref", "unknown")).toString(),
                streetBearing, frontBearing,
                t.getOrDefault("highway", "unknown").toString()
        };
    }

    /** Returns [way, seg] where seg is [nodeA, nodeB] */
    private Object[] bestSegment(double lat, double lon, List<Map<String, Object>> roads, String targetStreet) {
        Map<String, Object> nearestWay = null; Object[] nearestSeg = null; double nearestDist = Double.MAX_VALUE;
        Map<String, Object> matchWay = null; Object[] matchSeg = null; double matchDist = Double.MAX_VALUE;

        for (var way : roads) {
            var geom = geomList(way);
            var t = tags(way);
            var osmName = t.getOrDefault("name", t.getOrDefault("ref", "")).toString();
            boolean isMatch = targetStreet != null && !osmName.isEmpty() && namesMatch(osmName, targetStreet);

            for (int i = 0; i < geom.size() - 1; i++) {
                var a = geom.get(i); var b = geom.get(i + 1);
                double midLat = (toD(a.get("lat")) + toD(b.get("lat"))) / 2;
                double midLon = (toD(a.get("lon")) + toD(b.get("lon"))) / 2;
                double d = haversine(lat, lon, midLat, midLon);
                if (d < nearestDist) { nearestDist = d; nearestWay = way; nearestSeg = new Object[]{a, b}; }
                if (isMatch && d < matchDist) { matchDist = d; matchWay = way; matchSeg = new Object[]{a, b}; }
            }
        }
        return matchSeg != null ? new Object[]{matchWay, matchSeg} : new Object[]{nearestWay, nearestSeg};
    }

    // ── Corner check ──────────────────────────────────────────────────────────

    private Map<String, Object> checkCorner(double lat, double lon, List<Map<String, Object>> roads,
                                             double streetBearing, double frontBearing,
                                             List<Map<String, Object>> buildings,
                                             Object excludeId, Map<String, Object> subjectBld) {
        for (var way : roads) {
            var geom = geomList(way);
            for (int i = 0; i < geom.size() - 1; i++) {
                var a = geom.get(i); var b = geom.get(i + 1);
                double da = haversine(lat, lon, toD(a.get("lat")), toD(a.get("lon")));
                double db = haversine(lat, lon, toD(b.get("lat")), toD(b.get("lon")));
                if (Math.min(da, db) > 20) continue;
                double segBearing = bearing(toD(a.get("lat")), toD(a.get("lon")), toD(b.get("lat")), toD(b.get("lon")));
                double angleDiff = Math.abs(((segBearing - streetBearing + 180) % 360) - 180);
                if (angleDiff > 30 && angleDiff < 150) {
                    double leftBearing = (frontBearing - 90 + 360) % 360;
                    double rightBearing = (frontBearing + 90) % 360;
                    double dl = Math.abs(((segBearing - leftBearing + 180) % 360) - 180);
                    double dr = Math.abs(((segBearing - rightBearing + 180) % 360) - 180);
                    double cornerBearing = dl < dr ? leftBearing : rightBearing;
                    try {
                        return sideInfo(lat, lon, cornerBearing, buildings, false, excludeId, subjectBld, 0);
                    } catch (Exception ignored) {}
                }
            }
        }
        return null;
    }

    // ── Neighborhood ──────────────────────────────────────────────────────────

    private Map<String, Object> buildNeighborhood(List<Map<String, Object>> elements, double lat, double lon) {
        var transitStops = new ArrayList<double[]>(); // [dist, type_encoded, name_index]
        var transitNames = new ArrayList<String>();
        var transitTypes = new ArrayList<String>();
        var amenityNearest = new TreeMap<String, double[]>(); // category → [dist, nameIdx]
        var amenityNames = new ArrayList<String>();
        var parks = new ArrayList<double[]>(); // [dist, nameIdx]
        var parkNames = new ArrayList<String>();
        boolean hasAlley = false;

        for (var el : elements) {
            var t = tags(el);
            var center = el.containsKey("center") ? (Map<String, Object>) el.get("center") : el;
            var eLat = center.get("lat"); var eLon = center.get("lon");
            if (eLat == null || eLon == null) continue;
            double dist = Math.round(haversine(lat, lon, toD(eLat), toD(eLon)));

            if ("service".equals(t.get("highway")) && "alley".equals(t.get("service"))) { hasAlley = true; continue; }
            if ("park".equals(t.get("leisure"))) {
                parkNames.add(t.getOrDefault("name", "unnamed park").toString());
                parks.add(new double[]{dist, parkNames.size() - 1});
                continue;
            }

            var hw = t.getOrDefault("highway", "").toString();
            var rw = t.getOrDefault("railway", "").toString();
            var pt = t.getOrDefault("public_transport", "").toString();
            if ("bus_stop".equals(hw) || List.of("station", "subway_entrance", "tram_stop").contains(rw) || "stop_position".equals(pt)) {
                String stopType = ("subway_entrance".equals(rw) || ("station".equals(rw) && "subway".equals(t.get("station")))) ? "subway"
                        : "station".equals(rw) ? "train"
                        : "tram_stop".equals(rw) ? "tram" : "bus";
                var name = t.getOrDefault("name", t.getOrDefault("ref", "")).toString();
                transitNames.add(name); transitTypes.add(stopType);
                transitStops.add(new double[]{dist, transitStops.size()});
                continue;
            }

            var amenity = t.getOrDefault("amenity", t.getOrDefault("shop", "")).toString();
            var category = AMENITY_CATEGORIES.get(amenity);
            if (category != null) {
                var name = t.getOrDefault("name", "").toString();
                if (!amenityNearest.containsKey(category) || dist < amenityNearest.get(category)[0]) {
                    amenityNames.add(name);
                    amenityNearest.put(category, new double[]{dist, amenityNames.size() - 1});
                }
            }
        }

        transitStops.sort(Comparator.comparingDouble(a -> a[0]));
        parks.sort(Comparator.comparingDouble(a -> a[0]));

        Map<String, Object> nearestTransit = null;
        if (!transitStops.isEmpty()) {
            int idx = (int) transitStops.get(0)[1];
            nearestTransit = Map.of("type", transitTypes.get(idx),
                    "name", transitNames.get(idx).isEmpty() ? null : transitNames.get(idx),
                    "distance_m", (int) transitStops.get(0)[0]);
        }

        Map<String, Object> nearestPark = null;
        if (!parks.isEmpty()) {
            nearestPark = Map.of("name", parkNames.get((int) parks.get(0)[1]), "distance_m", (int) parks.get(0)[0]);
        }

        var walkability = new LinkedHashMap<String, Object>();
        for (var entry : amenityNearest.entrySet()) {
            int idx = (int) entry.getValue()[1];
            walkability.put(entry.getKey(), Map.of(
                    "distance_m", (int) entry.getValue()[0],
                    "name", amenityNames.get(idx).isEmpty() ? null : amenityNames.get(idx)));
        }

        return Map.of("nearest_transit", nearestTransit, "walkability", walkability,
                "nearest_park", nearestPark, "alley_behind", hasAlley);
    }

    // ── Windows helper ────────────────────────────────────────────────────────

    private static boolean hasWindows(String sideDir, String facing) {
        if (facing == null) return true;
        if (sideDir.equals(facing)) return true;
        var cornerMap = Map.of("NE", Set.of("N", "E"), "NW", Set.of("N", "W"),
                "SE", Set.of("S", "E"), "SW", Set.of("S", "W"));
        var exposed = cornerMap.get(facing);
        return exposed != null && exposed.contains(sideDir);
    }

    // ── HTTP helpers ──────────────────────────────────────────────────────────

    private double[] geocode(String address) throws Exception {
        Thread.sleep(1000);
        var url = NOMINATIM_URL + "?q=" + URLEncoder.encode(address, StandardCharsets.UTF_8)
                + "&format=json&limit=1";
        var resp = get(url);
        var results = mapper.readValue(resp, new TypeReference<List<Map<String, Object>>>() {});
        if (results.isEmpty()) throw new Exception("No geocoding results for: " + address);
        return new double[]{toD(results.get(0).get("lat")), toD(results.get(0).get("lon"))};
    }

    private List<List<Map<String, Object>>> queryArea(double lat, double lon, int roadRadius) throws Exception {
        var query = String.format("""
                [out:json];
                (
                  way(around:%d,%.6f,%.6f)[highway][highway!~"footway|path|cycleway|service|steps|pedestrian"];
                  way["building"](around:80,%.6f,%.6f);
                );
                out geom tags;""", roadRadius, lat, lon, lat, lon);
        var elements = overpassPost(query);
        var roads = elements.stream().filter(e -> tags(e).containsKey("highway")).toList();
        var buildings = elements.stream().filter(e -> tags(e).containsKey("building")).toList();
        return List.of(new ArrayList<>(roads), new ArrayList<>(buildings));
    }

    private List<Map<String, Object>> fetchRoads(double lat, double lon, int radius) throws Exception {
        var query = String.format("""
                [out:json];
                way(around:%d,%.6f,%.6f)[highway][highway!~"footway|path|cycleway|service|steps|pedestrian"];
                out geom tags;""", radius, lat, lon);
        return overpassPost(query);
    }

    private List<Map<String, Object>> queryNeighborhood(double lat, double lon) throws Exception {
        var query = String.format("""
                [out:json];
                (
                  node(around:600,%.6f,%.6f)[highway=bus_stop];
                  node(around:600,%.6f,%.6f)[public_transport=stop_position];
                  node(around:600,%.6f,%.6f)[railway~"station|subway_entrance|tram_stop"];
                  node(around:500,%.6f,%.6f)[amenity~"supermarket|grocery|pharmacy|cafe|restaurant|fast_food|bar|bakery|gym"];
                  node(around:500,%.6f,%.6f)[shop~"supermarket|grocery|convenience|chemist|bakery"];
                  way(around:600,%.6f,%.6f)[leisure=park];
                  node(around:600,%.6f,%.6f)[leisure=park];
                  way(around:100,%.6f,%.6f)[highway=service][service=alley];
                );
                out center tags;""",
                lat, lon, lat, lon, lat, lon, lat, lon, lat, lon,
                lat, lon, lat, lon, lat, lon);
        return overpassPost(query);
    }

    private Object fetchFloodZone(double lat, double lon) throws Exception {
        var url = "https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL/MapServer/28/query"
                + "?geometry=" + lon + "," + lat
                + "&geometryType=esriGeometryPoint&inSR=4326"
                + "&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,ZONE_SUBTY"
                + "&returnGeometry=false&f=json";
        var data = mapper.readValue(get(url), new TypeReference<Map<String, Object>>() {});
        @SuppressWarnings("unchecked")
        var features = (List<Map<String, Object>>) data.getOrDefault("features", List.of());
        if (!features.isEmpty()) {
            @SuppressWarnings("unchecked")
            var attrs = (Map<String, Object>) features.get(0).getOrDefault("attributes", Map.of());
            var zone = attrs.getOrDefault("FLD_ZONE", "").toString();
            var sub = attrs.getOrDefault("ZONE_SUBTY", "").toString();
            return sub.isEmpty() ? zone : zone + " (" + sub + ")";
        }
        return null;
    }

    private Object fetchElevation(double lat, double lon) throws Exception {
        var url = "https://api.opentopodata.org/v1/ned10m?locations=" + lat + "," + lon;
        var data = mapper.readValue(get(url), new TypeReference<Map<String, Object>>() {});
        @SuppressWarnings("unchecked")
        var results = (List<Map<String, Object>>) data.getOrDefault("results", List.of());
        if (!results.isEmpty() && results.get(0).get("elevation") != null) {
            return Math.round(toD(results.get(0).get("elevation")) * 10) / 10.0;
        }
        return null;
    }

    private List<Map<String, Object>> overpassPost(String query) throws Exception {
        Exception last = null;
        for (var url : OVERPASS_MIRRORS) {
            try {
                var body = "data=" + URLEncoder.encode(query, StandardCharsets.UTF_8);
                var req = HttpRequest.newBuilder().uri(URI.create(url))
                        .header("User-Agent", USER_AGENT)
                        .header("Content-Type", "application/x-www-form-urlencoded")
                        .timeout(Duration.ofSeconds(30))
                        .POST(HttpRequest.BodyPublishers.ofString(body))
                        .build();
                var resp = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
                if (resp.statusCode() >= 400) throw new Exception("HTTP " + resp.statusCode());
                var data = mapper.readValue(resp.body(), new TypeReference<Map<String, Object>>() {});
                @SuppressWarnings("unchecked")
                var elements = (List<Map<String, Object>>) data.getOrDefault("elements", List.of());
                return elements;
            } catch (Exception e) { last = e; }
        }
        throw last;
    }

    private String get(String url) throws Exception {
        var req = HttpRequest.newBuilder().uri(URI.create(url))
                .header("User-Agent", USER_AGENT)
                .timeout(Duration.ofSeconds(10))
                .GET().build();
        var resp = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
        return resp.body();
    }

    // ── Data accessors ────────────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    private static Map<String, Object> tags(Map<String, Object> el) {
        if (el == null) return Map.of();
        var t = el.get("tags");
        return t instanceof Map<?, ?> ? (Map<String, Object>) t : Map.of();
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> geomList(Map<String, Object> el) {
        var g = el.get("geometry");
        return g instanceof List<?> ? (List<Map<String, Object>>) g : List.of();
    }

    private static List<double[]> geometry(Map<String, Object> el) {
        return geomList(el).stream()
                .map(n -> new double[]{toD(n.get("lat")), toD(n.get("lon"))})
                .toList();
    }

    private static double toD(Object o) {
        if (o == null) return 0;
        if (o instanceof Number n) return n.doubleValue();
        try { return Double.parseDouble(o.toString()); } catch (Exception e) { return 0; }
    }

    private static double round5(double v) { return Math.round(v * 100000) / 100000.0; }

    private static LinkedHashMap<String, Object> linkedMap(Object... kv) {
        var m = new LinkedHashMap<String, Object>();
        for (int i = 0; i < kv.length - 1; i += 2) m.put(kv[i].toString(), kv[i + 1]);
        return m;
    }
}
