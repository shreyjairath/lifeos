package com.lifeos.agents.shared_tools;

import org.jsoup.Jsoup;
import org.jsoup.nodes.Element;
import org.springframework.stereotype.Component;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.Set;

/**
 * Fetch and extract readable content from a web page using Jsoup.
 */
@Component
public class Browse {

    private static final int MAX_BYTES = 5_000_000;  // 5MB
    private static final int MAX_CHARS = 50_000;      // ~12k tokens
    private static final String USER_AGENT =
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
    private static final Set<String> REMOVE_TAGS = Set.of(
            "script", "style", "nav", "header", "footer", "aside", "iframe", "noscript");

    private final HttpClient httpClient = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    public Map<String, Object> fetch(String url) {
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            return Map.of("error", "Only http/https URLs are supported.", "url", url);
        }

        try {
            var request = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .header("User-Agent", USER_AGENT)
                    .timeout(Duration.ofSeconds(15))
                    .GET()
                    .build();

            var response = httpClient.send(request, HttpResponse.BodyHandlers.ofInputStream());

            if (response.statusCode() >= 400) {
                return Map.of("error", "HTTP " + response.statusCode(), "url", url);
            }

            var contentType = response.headers().firstValue("content-type").orElse("");
            if (!contentType.contains("text/html")) {
                return Map.of("error", "Non-HTML content type: " + contentType, "url", url);
            }

            var html = readLimited(response.body(), MAX_BYTES);
            var finalUrl = response.uri().toString();

            // Parse with Jsoup and extract main content
            var doc = Jsoup.parse(html, finalUrl);
            var title = doc.title();

            // Remove noise elements
            for (var tag : REMOVE_TAGS) {
                doc.select(tag).remove();
            }

            // Try to find main content area
            var text = extractContent(doc);

            if (text.isEmpty() || text.length() < 200) {
                return Map.of("error",
                        "Could not extract readable content (page may be JS-rendered or paywalled).",
                        "url", finalUrl, "title", title);
            }

            var wordCount = text.split("\\s+").length;
            var truncated = text.length() > MAX_CHARS;
            if (truncated) {
                text = text.substring(0, MAX_CHARS);
            }

            return Map.of(
                    "url", finalUrl,
                    "title", title != null ? title : "",
                    "content", text,
                    "truncated", truncated,
                    "word_count", wordCount
            );

        } catch (java.net.http.HttpTimeoutException e) {
            return Map.of("error", "Request timed out after 15s.", "url", url);
        } catch (Exception e) {
            return Map.of("error", e.getMessage() != null ? e.getMessage() : "Unknown error", "url", url);
        }
    }


    // ── Private ──────────────────────────────────────────────────────────────────

    private static String readLimited(InputStream is, int maxBytes) throws Exception {
        var buffer = new ByteArrayOutputStream();
        var chunk = new byte[65536];
        int total = 0, read;
        while ((read = is.read(chunk)) != -1) {
            buffer.write(chunk, 0, read);
            total += read;
            if (total >= maxBytes) break;
        }
        return buffer.toString(StandardCharsets.UTF_8);
    }

    private static String extractContent(org.jsoup.nodes.Document doc) {
        // Try common main content selectors
        for (var selector : new String[]{"article", "main", "[role=main]", ".post-content",
                ".article-body", ".entry-content", "#content"}) {
            var el = doc.selectFirst(selector);
            if (el != null) {
                var text = el.text();
                if (text.length() > 200) return text;
            }
        }
        // Fallback: body text
        var body = doc.body();
        return body != null ? body.text() : "";
    }
}
