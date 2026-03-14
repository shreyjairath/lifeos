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

@RestController
@RequestMapping("/api")
public class KnowledgeController {

    private static final List<String> ALLOWED_FILES = List.of("agent-notes");

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

    private static final List<String> PROMPT_PARTS = List.of("system-instructions.md", "onboarding.md");
    private static final Path PROMPT_PARTS_DIR = Path.of(System.getProperty("user.dir"))
            .resolve(".user-data/prompt-parts").normalize();

    @GetMapping("/prompt-parts")
    public Map<String, Object> listPromptParts() {
        return Map.of("parts", PROMPT_PARTS);
    }

    @GetMapping("/prompt-parts/{name}")
    public Map<String, Object> getPromptPart(@PathVariable String name) {
        if (!PROMPT_PARTS.contains(name))
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unknown prompt part: " + name);
        // User override takes precedence over classpath default
        var override = PROMPT_PARTS_DIR.resolve(name);
        try {
            if (Files.exists(override)) {
                return Map.of("name", name, "content", Files.readString(override, StandardCharsets.UTF_8));
            }
            try (var stream = getClass().getResourceAsStream("/prompt-parts/" + name)) {
                if (stream == null) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Not found: " + name);
                return Map.of("name", name, "content", new String(stream.readAllBytes(), StandardCharsets.UTF_8));
            }
        } catch (ResponseStatusException e) {
            throw e;
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, e.getMessage());
        }
    }

    @PutMapping("/prompt-parts/{name}")
    public Map<String, Object> putPromptPart(@PathVariable String name, @RequestBody Map<String, String> body) {
        if (!PROMPT_PARTS.contains(name))
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unknown prompt part: " + name);
        try {
            Files.createDirectories(PROMPT_PARTS_DIR);
            Files.writeString(PROMPT_PARTS_DIR.resolve(name), body.getOrDefault("content", ""), StandardCharsets.UTF_8);
            return Map.of("name", name, "status", "saved");
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, e.getMessage());
        }
    }
}
