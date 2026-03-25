package com.lifeos.agent.executor;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.lifeos.agent.executor.events.LlmEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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
 * Streams LLM responses via OpenRouter's OpenAI-compatible API (/v1/chat/completions).
 * Yields typed LlmEvent records.
 */
public class LlmClient {

    private static final Logger log = LoggerFactory.getLogger(LlmClient.class);
    private static final String API_URL = "https://openrouter.ai/api/v1/chat/completions";

    private final String apiKey;
    private final HttpClient httpClient;
    private final ObjectMapper mapper;
    private final ExecutorService streamExecutor;

    public LlmClient(String apiKey) {
        this.apiKey = apiKey;
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
        return stream(model, system, messages, tools, 4096, null, result);
    }

    public Flux<LlmEvent> stream(
            String model,
            String system,
            List<Map<String, Object>> messages,
            List<Map<String, Object>> tools,
            Map<String, Object> reasoning,
            LlmResult result
    ) {
        return stream(model, system, messages, tools, 4096, reasoning, result);
    }

    /**
     * Stream an LLM response, yielding typed events and populating result.
     */
    public Flux<LlmEvent> stream(
            String model,
            String system,
            List<Map<String, Object>> messages,
            List<Map<String, Object>> tools,
            int maxTokens,
            Map<String, Object> reasoning,
            LlmResult result
    ) {
        return Flux.create(sink -> {
            sink.next(new LlmEvent.Request(model, maxTokens, system, messages, tools != null ? tools : List.of()));

            streamExecutor.submit(() -> {
                try {
                    doStream(model, system, messages, tools, maxTokens, reasoning, result, sink);
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
            int maxTokens, Map<String, Object> reasoning, LlmResult result, FluxSink<LlmEvent> sink
    ) throws Exception {
        var body = buildRequestBody(model, system, messages, tools, maxTokens, reasoning);

        var request = HttpRequest.newBuilder()
                .uri(URI.create(API_URL))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + apiKey)
                .header("HTTP-Referer", "https://github.com/lifeos")
                .header("X-Title", "lifeos")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();

        var response = httpClient.send(request, HttpResponse.BodyHandlers.ofInputStream());

        if (response.statusCode() != 200) {
            var errorBody = new String(response.body().readAllBytes());
            throw new RuntimeException("LLM API error " + response.statusCode() + ": " + errorBody);
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
                onChunk(node, result, toolUses, sink);
            }
        }

        finalize(result, toolUses, sink);
    }

    private String buildRequestBody(
            String model, String system,
            List<Map<String, Object>> messages, List<Map<String, Object>> tools,
            int maxTokens, Map<String, Object> reasoning
    ) throws JsonProcessingException {
        var body = new LinkedHashMap<String, Object>();
        body.put("model", model);

        // System prompt as first message; remaining messages already in OpenAI format
        var allMessages = new ArrayList<Map<String, Object>>();
        allMessages.add(Map.of("role", "system", "content", system));
        for (var m : messages) {
            var filtered = new LinkedHashMap<String, Object>();
            m.forEach((k, v) -> { if (!k.startsWith("_")) filtered.put(k, v); });
            allMessages.add(filtered);
        }
        body.put("messages", allMessages);

        // Convert tools: ToolsRegistry uses input_schema; OpenAI expects parameters
        if (tools != null && !tools.isEmpty()) {
            body.put("tools", tools.stream().map(t -> Map.of(
                    "type", "function",
                    "function", Map.of(
                            "name", t.get("name"),
                            "description", t.get("description"),
                            "parameters", t.get("input_schema")
                    )
            )).toList());
        }

        body.put("max_tokens", maxTokens);
        body.put("stream", true);
        body.put("stream_options", Map.of("include_usage", true));
        if (reasoning != null && !reasoning.isEmpty()) {
            body.put("reasoning", reasoning);
        }
        return mapper.writeValueAsString(body);
    }

    private void onChunk(
            JsonNode node, LlmResult result,
            List<ToolUseAccumulator> toolUses, FluxSink<LlmEvent> sink
    ) {
        // Usage arrives in the final SSE chunk
        if (node.has("usage") && !node.get("usage").isNull()) {
            var usage = node.get("usage");
            result.setUsage(Map.of(
                    "input_tokens", usage.path("prompt_tokens").asInt(),
                    "output_tokens", usage.path("completion_tokens").asInt()
            ));
        }

        var choices = node.get("choices");
        if (choices == null || !choices.isArray() || choices.isEmpty()) return;

        var choice = choices.get(0);
        var delta = choice.get("delta");

        if (delta != null && delta.has("content") && !delta.get("content").isNull()) {
            var text = delta.get("content").asText();
            if (!text.isEmpty()) {
                result.appendText(text);
                sink.next(new LlmEvent.Text(text));
            }
        }

        // Reasoning content — OpenRouter uses "reasoning" for DeepSeek R1, some models use "reasoning_content"
        if (delta != null) {
            var reasoningNode = delta.has("reasoning") && !delta.get("reasoning").isNull()
                    ? delta.get("reasoning")
                    : delta.has("reasoning_content") && !delta.get("reasoning_content").isNull()
                            ? delta.get("reasoning_content")
                            : null;
            if (reasoningNode != null) {
                var reasoning = reasoningNode.asText();
                if (!reasoning.isEmpty()) {
                    result.appendReasoning(reasoning);
                    sink.next(new LlmEvent.Reasoning(reasoning));
                }
            }
        }

        // Tool calls — streamed incrementally, keyed by index
        if (delta != null && delta.has("tool_calls")) {
            for (var tcNode : delta.get("tool_calls")) {
                int index = tcNode.path("index").asInt(0);
                while (toolUses.size() <= index) toolUses.add(new ToolUseAccumulator());
                var acc = toolUses.get(index);
                if (tcNode.has("id") && !tcNode.get("id").isNull()) {
                    acc.id = tcNode.get("id").asText();
                }
                var fn = tcNode.get("function");
                if (fn != null) {
                    if (fn.has("name") && !fn.get("name").isNull()) {
                        acc.name = fn.get("name").asText();
                    }
                    if (fn.has("arguments") && !fn.get("arguments").isNull()) {
                        acc.argumentsJson.append(fn.get("arguments").asText());
                    }
                }
            }
        }

        // Finish reason
        var finishReason = choice.path("finish_reason");
        if (!finishReason.isNull() && !finishReason.isMissingNode()) {
            var reason = finishReason.asText();
            if ("tool_calls".equals(reason)) {
                result.setStopReason("tool_use");  // normalize to internal name
                // Parse and emit ToolCall events now that arguments are complete
                for (var tu : toolUses) {
                    if (tu.name != null) {
                        Map<String, Object> parsed;
                        try {
                            parsed = tu.argumentsJson.isEmpty()
                                    ? Map.of()
                                    : mapper.readValue(tu.argumentsJson.toString(), new TypeReference<>() {});
                        } catch (JsonProcessingException e) {
                            parsed = Map.of();
                        }
                        tu.parsedInput = parsed;
                        sink.next(new LlmEvent.ToolCall(tu.name, parsed));
                    }
                }
            } else if ("stop".equals(reason)) {
                result.setStopReason("end_turn");
            } else if (!reason.isEmpty() && !"null".equals(reason)) {
                result.setStopReason(reason);
            }
        }
    }

    private void finalize(
            LlmResult result, List<ToolUseAccumulator> toolUses, FluxSink<LlmEvent> sink
    ) {
        // Build parsed tool uses list for Executor
        var parsedToolUses = new ArrayList<Map<String, Object>>();
        for (var tu : toolUses) {
            if (tu.id != null && tu.name != null) {
                if (tu.parsedInput == null) {
                    try {
                        tu.parsedInput = tu.argumentsJson.isEmpty()
                                ? Map.of()
                                : mapper.readValue(tu.argumentsJson.toString(), new TypeReference<>() {});
                    } catch (JsonProcessingException e) {
                        tu.parsedInput = Map.of();
                    }
                }
                parsedToolUses.add(Map.of(
                        "id", tu.id,
                        "name", tu.name,
                        "input", tu.parsedInput
                ));
            }
        }
        result.setParsedToolUses(parsedToolUses);

        // Build content list for LlmEvent.Response
        var content = new ArrayList<Map<String, Object>>();
        if (!result.getFullText().isEmpty()) {
            content.add(Map.of("type", "text", "text", result.getFullText()));
        }
        for (var tu : toolUses) {
            if (tu.id != null && tu.name != null) {
                content.add(Map.of(
                        "type", "tool_use",
                        "id", tu.id,
                        "name", tu.name,
                        "input", tu.parsedInput != null ? tu.parsedInput : Map.of()
                ));
            }
        }

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
        StringBuilder argumentsJson = new StringBuilder();
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

        private String fullReasoning = "";

        public String getFullText() { return fullText; }
        public void appendText(String text) { this.fullText += text; }
        public String getFullReasoning() { return fullReasoning; }
        public void appendReasoning(String text) { this.fullReasoning += text; }
        public List<Map<String, Object>> getParsedToolUses() { return parsedToolUses; }
        public void setParsedToolUses(List<Map<String, Object>> uses) { this.parsedToolUses = uses; }
        public String getStopReason() { return stopReason; }
        public void setStopReason(String reason) { this.stopReason = reason; }
        public Map<String, Integer> getUsage() { return usage; }
        public void setUsage(Map<String, Integer> usage) { this.usage = usage; }
    }
}
