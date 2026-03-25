package com.lifeos.app.api;

import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.MediaTypeFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;

import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Serves files from agent workspaces so they can be rendered as artifacts in the UI.
 * GET /api/artifacts/{agentName}/** → .user-data/agents/{agentName}/workspace/artifacts/**
 */
@RestController
@RequestMapping("/api/artifacts")
public class ArtifactsController {

    private static final Path AGENTS_DIR = Path.of(System.getProperty("user.dir"))
            .resolve(".user-data/agents").normalize();

    @GetMapping(value = "/{agentName}")
    public Mono<ResponseEntity<Object>> list(@PathVariable String agentName) {
        var artifacts = AGENTS_DIR.resolve(agentName).resolve("workspace").resolve("_artifacts").normalize();
        if (!Files.isDirectory(artifacts)) return Mono.just(ResponseEntity.ok().body((Object) java.util.List.of()));
        try (var stream = Files.walk(artifacts)) {
            var files = stream
                    .filter(Files::isRegularFile)
                    .map(p -> artifacts.relativize(p).toString())
                    .sorted()
                    .toList();
            return Mono.just(ResponseEntity.ok().body((Object) files));
        } catch (java.io.IOException e) {
            return Mono.just(ResponseEntity.internalServerError().<Object>build());
        }
    }

    @GetMapping(value = "/{agentName}/**")
    public Mono<ResponseEntity<Resource>> serve(
            @PathVariable String agentName,
            ServerHttpRequest request) {

        var fullPath = request.getPath().pathWithinApplication().value();
        var prefix = "/api/artifacts/" + agentName + "/";

        if (!fullPath.startsWith(prefix)) {
            return Mono.just(ResponseEntity.status(HttpStatus.BAD_REQUEST).<Resource>build());
        }
        var relativePath = fullPath.substring(prefix.length());

        var artifacts = AGENTS_DIR.resolve(agentName).resolve("workspace").resolve("_artifacts").normalize();
        var file = artifacts.resolve(relativePath).normalize();

        if (!file.startsWith(artifacts)) {
            return Mono.just(ResponseEntity.status(HttpStatus.FORBIDDEN).<Resource>build());
        }
        if (!Files.exists(file) || !Files.isRegularFile(file)) {
            return Mono.just(ResponseEntity.notFound().<Resource>build());
        }

        Resource resource = new FileSystemResource(file);
        var mediaType = MediaTypeFactory.getMediaType(resource).orElse(MediaType.APPLICATION_OCTET_STREAM);

        return Mono.just(ResponseEntity.ok().contentType(mediaType).body(resource));
    }
}
