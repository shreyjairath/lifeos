package com.lifeos.api;

import com.lifeos.core.EventBus;
import com.lifeos.tools.KnowledgeFiles;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

@RestController
@RequestMapping("/api")
public class KnowledgeController {

    private static final List<String> ALLOWED_FILES = List.of(
            "identity", "routines", "tools", "services", "integrations");

    private final KnowledgeFiles knowledgeFiles;
    private final EventBus eventBus;

    public KnowledgeController(KnowledgeFiles knowledgeFiles, EventBus eventBus) {
        this.knowledgeFiles = knowledgeFiles;
        this.eventBus = eventBus;
    }

    @GetMapping("/knowledge")
    public Map<String, Object> listKnowledge() {
        return Map.of("files", ALLOWED_FILES);
    }

    @GetMapping("/knowledge/{fileKey}")
    public Map<String, Object> getKnowledge(@PathVariable String fileKey) {
        var result = knowledgeFiles.read(fileKey);
        if (result.containsKey("error")) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, (String) result.get("error"));
        }
        return result;
    }

    @PutMapping("/knowledge/{fileKey}")
    public Map<String, Object> putKnowledge(@PathVariable String fileKey, @RequestBody Map<String, String> body) {
        var content = body.getOrDefault("content", "");
        var result = knowledgeFiles.update(fileKey, content);
        if (result.containsKey("error")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, (String) result.get("error"));
        }
        return result;
    }

    // ── Prompt parts ─────────────────────────────────────────────────────────────

    @GetMapping("/prompt-parts")
    public Map<String, Object> listPromptParts() {
        try (var stream = getClass().getResourceAsStream("/prompt-parts/")) {
            // Resource listing isn't straightforward; return known parts
            return Map.of("parts", List.of("persona.md", "onboarding.md"));
        } catch (Exception e) {
            return Map.of("parts", List.of());
        }
    }

    @GetMapping("/prompt-parts/{name}")
    public Map<String, Object> getPromptPart(@PathVariable String name) {
        try (var stream = getClass().getResourceAsStream("/prompt-parts/" + name)) {
            if (stream == null) {
                throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Prompt part '" + name + "' not found");
            }
            var content = new String(stream.readAllBytes(), StandardCharsets.UTF_8);
            return Map.of("name", name, "content", content);
        } catch (ResponseStatusException e) {
            throw e;
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, e.getMessage());
        }
    }
}
