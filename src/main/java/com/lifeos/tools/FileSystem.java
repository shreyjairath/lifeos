package com.lifeos.tools;

import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.stream.Stream;

/**
 * Filesystem tools — read/write files under .user-data/.
 */
@Component
public class FileSystem {

    private static final Path USER_DATA = Path.of(System.getProperty("user.dir"))
            .resolve(".user-data").normalize();

    public Map<String, Object> writeFile(String path, String content) {
        try {
            var target = resolveSafe(path);
            Files.createDirectories(target.getParent());
            Files.writeString(target, content, StandardCharsets.UTF_8);
            return Map.of("written", path, "chars", content.length());
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> readFile(String path) {
        try {
            var target = resolveSafe(path);
            if (!Files.exists(target)) return Map.of("error", "'" + path + "' does not exist.");
            if (!Files.isRegularFile(target)) return Map.of("error", "'" + path + "' is not a file.");
            var content = Files.readString(target, StandardCharsets.UTF_8);
            return Map.of("path", path, "content", content);
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> updateFile(String path, String oldStr, String newStr) {
        try {
            var target = resolveSafe(path);
            if (!Files.exists(target)) return Map.of("error", "'" + path + "' does not exist.");
            var content = Files.readString(target, StandardCharsets.UTF_8);
            int count = countOccurrences(content, oldStr);
            if (count == 0) return Map.of("error", "old_str not found in file.");
            if (count > 1) return Map.of("error", "old_str appears " + count + " times — provide more context.");
            var updated = content.replace(oldStr, newStr);
            Files.writeString(target, updated, StandardCharsets.UTF_8);
            return Map.of("updated", path, "chars", updated.length());
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> listDir(String path) {
        try {
            var target = resolveSafe(path);
            if (!Files.exists(target)) return Map.of("error", "'" + path + "' does not exist.");
            if (!Files.isDirectory(target)) return Map.of("error", "'" + path + "' is not a directory.");
            var entries = new ArrayList<Map<String, Object>>();
            try (Stream<Path> stream = Files.list(target).sorted()) {
                stream.forEach(entry -> entries.add(Map.of(
                        "name", entry.getFileName().toString(),
                        "type", Files.isDirectory(entry) ? "dir" : "file",
                        "path", USER_DATA.relativize(entry).toString()
                )));
            }
            return Map.of("path", path, "entries", entries);
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    private Path resolveSafe(String relativePath) throws IllegalArgumentException {
        var resolved = USER_DATA.resolve(relativePath).normalize();
        if (!resolved.startsWith(USER_DATA)) {
            throw new IllegalArgumentException("Path '" + relativePath + "' escapes .user-data/.");
        }
        return resolved;
    }

    private int countOccurrences(String text, String sub) {
        int count = 0, idx = 0;
        while ((idx = text.indexOf(sub, idx)) != -1) {
            count++;
            idx += sub.length();
        }
        return count;
    }
}
