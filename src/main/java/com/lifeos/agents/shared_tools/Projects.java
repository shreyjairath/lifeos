package com.lifeos.agents.shared_tools;

import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Project CRUD — folder-based projects at .user-data/knowledge/projects/{slug}/
 */
@Component
public class Projects {

    private static final Path ROOT = Path.of(System.getProperty("user.dir"))
            .resolve(".user-data/knowledge/projects").normalize();

    private static final List<String> SECTIONS = List.of(
            "context", "snapshot", "next_action", "waiting_on", "files", "log");
    private static final Map<String, String> SECTION_HEADERS = Map.of(
            "context", "## Context",
            "snapshot", "## Snapshot",
            "next_action", "## Next Action",
            "waiting_on", "## Waiting On",
            "files", "## Files",
            "log", "## Log");

    public Map<String, Object> create(String name, String goal, String context) {
        try {
            var slug = slugify(name);
            if (Files.exists(ROOT.resolve(slug))) {
                return Map.of("error", "Project '" + name + "' already exists. Use update_project to modify it.");
            }
            Files.createDirectories(ROOT.resolve(slug).resolve("data"));
            write(projectMd(slug), buildProjectMd(name, goal, context));
            return Map.of("created", ROOT.resolve(slug).toString(), "name", name, "goal", goal);
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> read(String name) {
        var slug = findSlug(name);
        if (slug == null) return Map.of("error", "Project '" + name + "' not found.");
        return Map.of("name", slug, "content", readProjectMd(slug));
    }

    public Map<String, Object> update(String name, String section, String content) {
        if (!SECTIONS.contains(section)) {
            return Map.of("error", "Invalid section '" + section + "'. Must be one of: " + String.join(", ", SECTIONS));
        }
        var slug = findSlug(name);
        if (slug == null) return Map.of("error", "Project '" + name + "' not found.");
        try {
            var current = readProjectMd(slug);
            if ("log".equals(section)) {
                var today = LocalDate.now().format(DateTimeFormatter.ISO_LOCAL_DATE);
                var entry = "**" + today + ":** " + content.strip();
                var header = SECTION_HEADERS.get("log");
                if (current.contains(header)) {
                    var logStart = current.indexOf(header) + header.length();
                    current = current.substring(0, logStart) + "\n" + entry + "\n" +
                            current.substring(logStart).stripLeading();
                } else {
                    current = current.stripTrailing() + "\n\n" + header + "\n" + entry + "\n";
                }
            } else {
                current = replaceSection(current, section, content);
            }
            write(projectMd(slug), current);
            return Map.of("updated", "project.md", "project", slug, "section", section);
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> list() {
        var projects = new ArrayList<Map<String, Object>>();
        try {
            for (var slug : listSlugs()) {
                var content = readProjectMd(slug);
                if (content.isEmpty()) continue;
                var statusMatch = Pattern.compile("\\*\\*Status:\\*\\*\\s*(.+)").matcher(content);
                var status = statusMatch.find() ? statusMatch.group(1).strip() : "unknown";
                if ("deleted".equals(status)) continue;
                var goalMatch = Pattern.compile("\\*\\*Goal:\\*\\*\\s*(.+)").matcher(content);
                var naMatch = Pattern.compile("## Next Action\n(.*?)(?=\n## |\\Z)", Pattern.DOTALL).matcher(content);
                projects.add(Map.of(
                        "name", slug,
                        "status", status,
                        "goal", goalMatch.find() ? goalMatch.group(1).strip() : "",
                        "next_action", naMatch.find() ? naMatch.group(1).strip() : ""
                ));
            }
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
        return Map.of("projects", projects);
    }

    public Map<String, Object> addFile(String project, String filename, String description, String content) {
        var slug = findSlug(project);
        if (slug == null) return Map.of("error", "Project '" + project + "' not found.");
        try {
            write(dataFile(slug, filename), content);
            var projContent = readProjectMd(slug);
            var header = SECTION_HEADERS.get("files");
            var newEntry = "- " + filename + " — " + description;
            if (projContent.contains(header)) {
                var filesStart = projContent.indexOf(header) + header.length();
                var rest = projContent.substring(filesStart);
                var nextSection = Pattern.compile("\n## ").matcher(rest);
                var endPos = nextSection.find() ? filesStart + nextSection.start() : projContent.length();
                var currentBody = projContent.substring(filesStart, endPos).strip();
                var newBody = ("*No files yet.*".equals(currentBody) || currentBody.isEmpty())
                        ? newEntry : currentBody + "\n" + newEntry;
                projContent = projContent.substring(0, filesStart) + "\n" + newBody + "\n\n" +
                        projContent.substring(endPos).stripLeading();
            } else {
                projContent = projContent.stripTrailing() + "\n\n" + header + "\n" + newEntry + "\n";
            }
            write(projectMd(slug), projContent);
            return Map.of("created", filename, "project", slug, "filename", filename);
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> readFile(String project, String filename) {
        var slug = findSlug(project);
        if (slug == null) return Map.of("error", "Project '" + project + "' not found.");
        var path = dataFile(slug, filename);
        if (!Files.exists(path)) return Map.of("error", "File '" + filename + "' not found in project '" + project + "'.");
        try {
            return Map.of("project", slug, "filename", filename,
                    "content", Files.readString(path, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> updateFile(String project, String filename, String content) {
        var slug = findSlug(project);
        if (slug == null) return Map.of("error", "Project '" + project + "' not found.");
        var path = dataFile(slug, filename);
        if (!Files.exists(path)) return Map.of("error", "File '" + filename + "' not found in project '" + project + "'.");
        try {
            write(path, content);
            return Map.of("updated", filename, "project", slug, "filename", filename);
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> deleteFile(String project, String filename) {
        var slug = findSlug(project);
        if (slug == null) return Map.of("error", "Project '" + project + "' not found.");
        var path = dataFile(slug, filename);
        if (!Files.exists(path)) return Map.of("error", "File '" + filename + "' not found in project '" + project + "'.");
        try {
            Files.deleteIfExists(path);
            var projContent = readProjectMd(slug);
            var escaped = Pattern.quote(filename);
            projContent = projContent.replaceAll("(?m)^- " + escaped + "\\s*[—-].*\n?", "");
            write(projectMd(slug), projContent);
            return Map.of("deleted", filename, "project", slug);
        } catch (Exception e) {
            return Map.of("error", e.getMessage());
        }
    }

    // ── Paths ────────────────────────────────────────────────────────────────────

    public static Path projectDir(String slug) { return ROOT.resolve(slug); }
    private static Path projectMd(String slug)  { return ROOT.resolve(slug).resolve("project.md"); }
    private static Path dataFile(String s, String f) { return ROOT.resolve(s).resolve("data").resolve(f); }

    // ── Helpers ──────────────────────────────────────────────────────────────────

    private static String readProjectMd(String slug) {
        var path = projectMd(slug);
        if (!Files.exists(path)) return "";
        try { return Files.readString(path, StandardCharsets.UTF_8); } catch (IOException e) { return ""; }
    }

    private static void write(Path path, String content) {
        try {
            Files.createDirectories(path.getParent());
            Files.writeString(path, content, StandardCharsets.UTF_8);
        } catch (IOException e) { throw new UncheckedIOException(e); }
    }

    static List<String> listSlugs() {
        if (!Files.exists(ROOT)) return List.of();
        try (Stream<Path> s = Files.list(ROOT).sorted()) {
            return s.filter(Files::isDirectory).map(p -> p.getFileName().toString()).toList();
        } catch (IOException e) { return List.of(); }
    }

    private static String slugify(String name) {
        return name.toLowerCase().strip().replaceAll("[^a-z0-9-]", "-").replaceAll("^-+|-+$", "");
    }

    private static String findSlug(String name) {
        var slug = slugify(name);
        if (Files.exists(ROOT.resolve(slug))) return slug;
        for (var s : listSlugs()) { if (s.contains(slug)) return s; }
        return null;
    }

    private static String replaceSection(String content, String section, String newBody) {
        var header = SECTION_HEADERS.get(section);
        var headerPattern = Pattern.compile("^## .+$", Pattern.MULTILINE);
        var matcher = headerPattern.matcher(content);
        int targetStart = -1, targetEnd = -1, nextStart = -1;
        while (matcher.find()) {
            if (matcher.group().strip().equals(header)) {
                targetStart = matcher.start();
                targetEnd = matcher.end();
            } else if (targetEnd >= 0 && nextStart < 0) {
                nextStart = matcher.start();
            }
        }
        if (targetStart < 0) {
            return content.stripTrailing() + "\n\n" + header + "\n" + newBody.strip() + "\n";
        }
        var end = nextStart >= 0 ? nextStart : content.length();
        return content.substring(0, targetEnd) + "\n" + newBody.strip() + "\n\n" +
                content.substring(end).stripLeading();
    }

    private static String buildProjectMd(String name, String goal, String context) {
        var today = LocalDate.now().format(DateTimeFormatter.ISO_LOCAL_DATE);
        var contextBody = (context != null && !context.isBlank()) ? context.strip()
                : "*The setting. Who's involved, why this matters, constraints and background that shape every decision. Written once, rarely changes.*";
        return """
                # %s

                **Goal:** %s
                **Created:** %s
                **Status:** active

                ## Context
                %s

                ## Snapshot
                *Current state. Where we are, what's been tried/dropped and why, key decisions made. Overwritten each session.*

                ## Next Action
                **Owner:** User
                **Action:** Define first steps.
                **Why:** Project just created — needs direction.

                ## Waiting On
                *Nothing blocked.*

                ## Files
                *No files yet.*

                ## Log
                **%s:** Project created.
                """.formatted(name, goal, today, contextBody, today);
    }
}
