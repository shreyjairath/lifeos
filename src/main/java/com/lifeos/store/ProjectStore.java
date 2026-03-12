package com.lifeos.store;

import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;

/**
 * Raw file I/O for the projects subtree: .user-data/knowledge/projects/{slug}/
 */
@Component
public class ProjectStore {

    private static final Path PROJECTS = Path.of(System.getProperty("user.dir"))
            .resolve(".user-data/knowledge/projects").normalize();

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    public boolean exists(String slug) {
        return Files.isDirectory(PROJECTS.resolve(slug));
    }

    /** Creates the project dir and its data/ subfolder. */
    public void init(String slug) {
        try {
            Files.createDirectories(PROJECTS.resolve(slug).resolve("data"));
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to init project: " + slug, e);
        }
    }

    // ── project.md ───────────────────────────────────────────────────────────

    public String readProjectMd(String slug) {
        var path = PROJECTS.resolve(slug).resolve("project.md");
        if (!Files.exists(path)) return "";
        try {
            return Files.readString(path, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "";
        }
    }

    public void writeProjectMd(String slug, String content) {
        var path = PROJECTS.resolve(slug).resolve("project.md");
        try {
            Files.createDirectories(path.getParent());
            Files.writeString(path, content, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to write project.md for: " + slug, e);
        }
    }

    // ── data/ files ───────────────────────────────────────────────────────────

    public boolean dataFileExists(String slug, String filename) {
        return Files.exists(PROJECTS.resolve(slug).resolve("data").resolve(filename));
    }

    public String readDataFile(String slug, String filename) {
        try {
            return Files.readString(PROJECTS.resolve(slug).resolve("data").resolve(filename), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to read data file: " + filename, e);
        }
    }

    public void writeDataFile(String slug, String filename, String content) {
        var path = PROJECTS.resolve(slug).resolve("data").resolve(filename);
        try {
            Files.createDirectories(path.getParent());
            Files.writeString(path, content, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to write data file: " + filename, e);
        }
    }

    public void deleteDataFile(String slug, String filename) {
        try {
            Files.delete(PROJECTS.resolve(slug).resolve("data").resolve(filename));
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to delete data file: " + filename, e);
        }
    }

    // ── Listings ──────────────────────────────────────────────────────────────

    public List<Path> listProjectDirs() {
        if (!Files.exists(PROJECTS)) return List.of();
        try (Stream<Path> dirs = Files.list(PROJECTS).sorted()) {
            return dirs.filter(Files::isDirectory).toList();
        } catch (IOException e) {
            return List.of();
        }
    }

    // ── Path helpers ──────────────────────────────────────────────────────────

    public Path projectDir(String slug) { return PROJECTS.resolve(slug); }

    public Path dataDir(String slug) { return PROJECTS.resolve(slug).resolve("data"); }
}
