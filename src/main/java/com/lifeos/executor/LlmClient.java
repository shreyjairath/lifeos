package com.lifeos.executor;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.lifeos.config.AppConfig;
import com.lifeos.executor.events.LlmEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.FluxSink;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Streams Claude API responses via raw HTTP SSE.
 * Yields typed LlmEvent records.
 */
@Component
public class LlmClient {

    private static final Logger log = LoggerFactory.getLogger(LlmClient.class);
    private static final String API_URL = "https://api.anthropic.com/v1/messages";
    private static final String API_VERSION = "2023-06-01";

    private final String apiKey;
    private final HttpClient httpClient;
    private final ObjectMapper mapper;
    private final ExecutorService streamExecutor;

    public LlmClient(AppConfig config) {
        this.apiKey = config.anthropicApiKey();
        this.httpClient = HttpClient.newHttpClient();
        this.mapper = new ObjectMapper();
        this.streamExecutor = Executors.newVirtualThreadPerTaskExecutor();
    }

    public Flux<LlmEvent> stream(
            String model,
            String system,
            List<Map<String, Object>> messages,
            List<Map<String, Object>> tools,
            LlmResult result
    ) {
        return stream(model, system, messages, tools, 4096, result);
    }

    /**
     * Stream a Claude response, yielding typed events and populating result.
     */
    public Flux<LlmEvent> stream(
            String model,
            String system,
            List<Map<String, Object>> messages,
            List<Map<String, Object>> tools,
            int maxTokens,
            LlmResult result
    ) {
        return Flux.create(sink -> {
            sink.next(new LlmEvent.Request(model, maxTokens, system, messages, tools != null ? tools : List.of()));

            streamExecutor.submit(() -> {
                try {
                    doStream(model, system, messages, tools, maxTokens, result, sink);
                    sink.complete();
                } catch (Exception e) {
                    sink.error(e);
                }
            });
        });
    }


    // ── Private ──────────────────────────────────────────────────────────────────

    private void doStream(
            String model, String system,
            List<Map<String, Object>> messages, List<Map<String, Object>> tools,
            int maxTokens, LlmResult result, FluxSink<LlmEvent> sink
    ) throws Exception {
        var body = buildRequestBody(model, system, messages, tools, maxTokens);

        var request = HttpRequest.newBuilder()
                .uri(URI.create(API_URL))
                .header("Content-Type", "application/json")
                .header("x-api-key", apiKey)
                .header("anthropic-version", API_VERSION)
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();

        var response = httpClient.send(request, HttpResponse.BodyHandlers.ofInputStream());

        if (response.statusCode() != 200) {
            var errorBody = new String(response.body().readAllBytes());
            throw new RuntimeException("Anthropic API error " + response.statusCode() + ": " + errorBody);
        }

        var toolUses = new ArrayList<ToolUseAccumulator>();

        try (var reader = new BufferedReader(new InputStreamReader(response.body()))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (sink.isCancelled()) return;

                if (!line.startsWith("data: ")) continue;
                var data = line.substring(6).strip();
                if (data.equals("[DONE]")) break;

                var node = mapper.readTree(data);
                var type = node.has("type") ? node.get("type").asText() : "";

                switch (type) {
                    case "content_block_start" -> onBlockStart(node, toolUses);
                    case "content_block_delta" -> onBlockDelta(node, result, toolUses, sink);
                    case "content_block_stop" -> onBlockStop(node, toolUses, sink);
                    case "message_delta" -> onMessageDelta(node, result);
                    case "message_stop" -> { /* stream complete */ }
                }
            }
        }

        finalize(result, toolUses, sink);
    }

    private String buildRequestBody(
            String model, String system,
            List<Map<String, Object>> messages, List<Map<String, Object>> tools,
            int maxTokens
    ) throws JsonProcessingException {
        var body = new LinkedHashMap<String, Object>();
        body.put("model", model);
        body.put("system", system);
        body.put("messages", messages.stream()
                .map(m -> m.entrySet().stream()
                        .filter(e -> !e.getKey().startsWith("_"))
                        .collect(java.util.stream.Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue,
                                (a, b) -> a, LinkedHashMap::new)))
                .toList());
        if (tools != null && !tools.isEmpty()) {
            body.put("tools", tools);
        }
        body.put("max_tokens", maxTokens);
        body.put("stream", true);
        return mapper.writeValueAsString(body);
    }

    private void onBlockStart(JsonNode node, List<ToolUseAccumulator> toolUses) {
        var cb = node.get("content_block");
        if (cb != null && "tool_use".equals(cb.path("type").asText())) {
            var acc = new ToolUseAccumulator();
            acc.id = cb.get("id").asText();
            acc.name = cb.get("name").asText();
            acc.index = node.get("index").asInt();
            toolUses.add(acc);
        }
    }

    private void onBlockDelta(
            JsonNode node, LlmResult result,
            List<ToolUseAccumulator> toolUses, FluxSink<LlmEvent> sink
    ) {
        var delta = node.get("delta");
        if (delta == null) return;

        var deltaType = delta.path("type").asText();
        if ("text_delta".equals(deltaType)) {
            var text = delta.get("text").asText();
            result.appendText(text);
            sink.next(new LlmEvent.Text(text));
        } else if ("input_json_delta".equals(deltaType) && !toolUses.isEmpty()) {
            toolUses.getLast().inputJson.append(delta.get("partial_json").asText());
        }
    }

    private void onBlockStop(
            JsonNode node, List<ToolUseAccumulator> toolUses, FluxSink<LlmEvent> sink
    ) {
        int index = node.path("index").asInt(-1);
        if (index < 0) return;

        for (var tu : toolUses) {
            if (tu.index == index) {
                Map<String, Object> parsed;
                try {
                    parsed = tu.inputJson.isEmpty()
                            ? Map.of()
                            : mapper.readValue(tu.inputJson.toString(), new TypeReference<>() {});
                } catch (JsonProcessingException e) {
                    parsed = Map.of();
                }
                tu.parsedInput = parsed;
                sink.next(new LlmEvent.ToolCall(tu.name, parsed));
                return;
            }
        }
    }

    private void onMessageDelta(JsonNode node, LlmResult result) {
        var delta = node.get("delta");
        if (delta != null && delta.has("stop_reason")) {
            result.setStopReason(delta.get("stop_reason").asText());
        }
        var usage = node.get("usage");
        if (usage != null) {
            result.setUsage(Map.of(
                    "input_tokens", usage.path("input_tokens").asInt(),
                    "output_tokens", usage.path("output_tokens").asInt()
            ));
        }
    }

    private void finalize(
            LlmResult result, List<ToolUseAccumulator> toolUses, FluxSink<LlmEvent> sink
    ) {
        // Build parsed tool uses
        var parsedToolUses = new ArrayList<Map<String, Object>>();
        for (var tu : toolUses) {
            parsedToolUses.add(Map.of(
                    "id", tu.id,
                    "name", tu.name,
                    "input", tu.parsedInput != null ? tu.parsedInput : Map.of()
            ));
        }
        result.setParsedToolUses(parsedToolUses);

        // Build content list for the response event
        var content = new ArrayList<Map<String, Object>>();
        if (!result.getFullText().isEmpty()) {
            content.add(Map.of("type", "text", "text", result.getFullText()));
        }
        for (var tu : toolUses) {
            content.add(Map.of(
                    "type", "tool_use",
                    "id", tu.id,
                    "name", tu.name,
                    "input", tu.parsedInput != null ? tu.parsedInput : Map.of()
            ));
        }

        // Usage may have been set by message_delta; if not, default to zeros
        if (result.getUsage() == null) {
            result.setUsage(Map.of("input_tokens", 0, "output_tokens", 0));
        }

        sink.next(new LlmEvent.Response(
                result.getStopReason() != null ? result.getStopReason() : "end_turn",
                result.getUsage(),
                content
        ));
    }


    // ── Inner types ──────────────────────────────────────────────────────────────

    private static class ToolUseAccumulator {
        String id;
        String name;
        int index;
        StringBuilder inputJson = new StringBuilder();
        Map<String, Object> parsedInput;
    }

    /**
     * Mutable result accumulator populated during streaming.
     */
    public static class LlmResult {
        private String fullText = "";
        private List<Map<String, Object>> parsedToolUses = List.of();
        private String stopReason;
        private Map<String, Integer> usage;

        public String getFullText() { return fullText; }
        public void appendText(String text) { this.fullText += text; }
        public List<Map<String, Object>> getParsedToolUses() { return parsedToolUses; }
        public void setParsedToolUses(List<Map<String, Object>> uses) { this.parsedToolUses = uses; }
        public String getStopReason() { return stopReason; }
        public void setStopReason(String reason) { this.stopReason = reason; }
        public Map<String, Integer> getUsage() { return usage; }
        public void setUsage(Map<String, Integer> usage) { this.usage = usage; }
    }
}
