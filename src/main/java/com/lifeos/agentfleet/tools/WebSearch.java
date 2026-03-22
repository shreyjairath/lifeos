package com.lifeos.agentfleet.tools;

import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Web search via DuckDuckGo HTML endpoint.
 */
@Component
public class WebSearch {

    private static final String USER_AGENT =
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
    private static final Pattern LINK_PATTERN = Pattern.compile(
            "class=\"result__a\"[^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>", Pattern.DOTALL);
    private static final Pattern SNIPPET_PATTERN = Pattern.compile(
            "class=\"result__snippet\"[^>]*>(.*?)</[a-z]+>", Pattern.DOTALL);
    private static final Pattern STRIP_HTML = Pattern.compile("<[^>]+>");

    private final HttpClient httpClient = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    public Map<String, Object> search(String query) {
        return search(query, 5);
    }

    public Map<String, Object> search(String query, int maxResults) {
        try {
            var encoded = URLEncoder.encode(query, StandardCharsets.UTF_8);
            var request = HttpRequest.newBuilder()
                    .uri(URI.create("https://html.duckduckgo.com/html/?q=" + encoded))
                    .header("User-Agent", USER_AGENT)
                    .timeout(java.time.Duration.ofSeconds(10))
                    .GET()
                    .build();

            var response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() != 200) {
                return Map.of("error", "HTTP " + response.statusCode(), "results", List.of());
            }

            var html = response.body();
            var linkMatcher = LINK_PATTERN.matcher(html);
            var snippetMatcher = SNIPPET_PATTERN.matcher(html);

            var links = new ArrayList<String[]>();
            while (linkMatcher.find()) {
                links.add(new String[]{linkMatcher.group(1), stripHtml(linkMatcher.group(2))});
            }
            var snippets = new ArrayList<String>();
            while (snippetMatcher.find()) {
                snippets.add(stripHtml(snippetMatcher.group(1)));
            }

            var results = new ArrayList<Map<String, Object>>();
            for (int i = 0; i < Math.min(links.size(), maxResults); i++) {
                var snippet = i < snippets.size() ? snippets.get(i) : "";
                results.add(Map.of(
                        "title", links.get(i)[1],
                        "url", links.get(i)[0],
                        "snippet", snippet
                ));
            }

            return Map.of("query", query, "results", results);
        } catch (Exception e) {
            return Map.of("error", e.getMessage(), "results", List.of());
        }
    }

    private static String stripHtml(String html) {
        return STRIP_HTML.matcher(html).replaceAll("").strip();
    }
}
