package com.lifeos.tools;

import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Project CRUD — folder-based projects at .user-data/projects/{slug}/project.md
 */
@Component
public class Projects {

    private static final Path USER_DATA = Path.of(System.getProperty("user.dir"))
            .resolve("../.user-data").normalize();
    private static final Path PROJECTS_DIR = USER_DATA.resolve("projects");
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
            Files.createDirectories(PROJECTS_DIR);
            var slug = slugify(name);
            var projDir = PROJECTS_DIR.resolve(slug);
            if (Files.exists(projDir)) {
                return Map.of("error", "Project '" + name + "' already exists. Use update_project to modify it.");
            }
            Files.createDirectories(projDir.resolve("data"));
            var path = projDir.resolve("project.md");
            Files.writeString(path, buildProjectMd(name, goal, context), StandardCharsets.UTF_8);
            return Map.of("created", projDir.toString(), "name", name, "goal", goal);
        } catch (IOException e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> read(String name) {
        var path = findProject(name);
        if (path == null) return Map.of("error", "Project '" + name + "' not found.");
        try {
            return Map.of("name", path.getParent().getFileName().toString(),
                    "content", Files.readString(path, StandardCharsets.UTF_8));
        } catch (IOException e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> update(String name, String section, String content) {
        if (!SECTIONS.contains(section)) {
            return Map.of("error", "Invalid section '" + section + "'. Must be one of: " + String.join(", ", SECTIONS));
        }
        var path = findProject(name);
        if (path == null) return Map.of("error", "Project '" + name + "' not found.");
        try {
            var current = Files.readString(path, StandardCharsets.UTF_8);
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
            Files.writeString(path, current, StandardCharsets.UTF_8);
            return Map.of("updated", path.getFileName().toString(),
                    "project", path.getParent().getFileName().toString(), "section", section);
        } catch (IOException e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> list() {
        if (!Files.exists(PROJECTS_DIR)) return Map.of("projects", List.of());
        var projects = new ArrayList<Map<String, Object>>();
        try (Stream<Path> dirs = Files.list(PROJECTS_DIR).sorted()) {
            for (var projDir : dirs.toList()) {
                if (!Files.isDirectory(projDir)) continue;
                var md = projDir.resolve("project.md");
                if (!Files.exists(md)) continue;
                var content = Files.readString(md, StandardCharsets.UTF_8);

                var statusMatch = Pattern.compile("\\*\\*Status:\\*\\*\\s*(.+)").matcher(content);
                var status = statusMatch.find() ? statusMatch.group(1).strip() : "unknown";
                if ("deleted".equals(status)) continue;

                var goalMatch = Pattern.compile("\\*\\*Goal:\\*\\*\\s*(.+)").matcher(content);
                var naMatch = Pattern.compile("## Next Action\n(.*?)(?=\n## |\\Z)", Pattern.DOTALL).matcher(content);

                projects.add(Map.of(
                        "name", projDir.getFileName().toString(),
                        "status", status,
                        "goal", goalMatch.find() ? goalMatch.group(1).strip() : "",
                        "next_action", naMatch.find() ? naMatch.group(1).strip() : ""
                ));
            }
        } catch (IOException e) {
            return Map.of("error", e.getMessage());
        }
        return Map.of("projects", projects);
    }

    public Map<String, Object> addFile(String project, String filename, String description, String content) {
        var path = findProject(project);
        if (path == null) return Map.of("error", "Project '" + project + "' not found.");
        try {
            var dataDir = path.getParent().resolve("data");
            Files.createDirectories(dataDir);
            var filePath = dataDir.resolve(filename);
            Files.writeString(filePath, content, StandardCharsets.UTF_8);

            // Update Files section in project.md
            var projContent = Files.readString(path, StandardCharsets.UTF_8);
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
            Files.writeString(path, projContent, StandardCharsets.UTF_8);
            return Map.of("created", filePath.toString(), "project", path.getParent().getFileName().toString(),
                    "filename", filename);
        } catch (IOException e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> readFile(String project, String filename) {
        var path = findProject(project);
        if (path == null) return Map.of("error", "Project '" + project + "' not found.");
        var filePath = path.getParent().resolve("data").resolve(filename);
        if (!Files.exists(filePath)) {
            return Map.of("error", "File '" + filename + "' not found in project '" + project + "'.");
        }
        try {
            return Map.of("project", path.getParent().getFileName().toString(),
                    "filename", filename,
                    "content", Files.readString(filePath, StandardCharsets.UTF_8));
        } catch (IOException e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> updateFile(String project, String filename, String content) {
        var path = findProject(project);
        if (path == null) return Map.of("error", "Project '" + project + "' not found.");
        var filePath = path.getParent().resolve("data").resolve(filename);
        if (!Files.exists(filePath)) {
            return Map.of("error", "File '" + filename + "' not found in project '" + project + "'.");
        }
        try {
            Files.writeString(filePath, content, StandardCharsets.UTF_8);
            return Map.of("updated", filePath.toString(), "project", path.getParent().getFileName().toString(),
                    "filename", filename);
        } catch (IOException e) {
            return Map.of("error", e.getMessage());
        }
    }

    public Map<String, Object> deleteFile(String project, String filename) {
        var path = findProject(project);
        if (path == null) return Map.of("error", "Project '" + project + "' not found.");
        var filePath = path.getParent().resolve("data").resolve(filename);
        if (!Files.exists(filePath)) {
            return Map.of("error", "File '" + filename + "' not found in project '" + project + "'.");
        }
        try {
            Files.delete(filePath);
            // Remove from Files section
            var projContent = Files.readString(path, StandardCharsets.UTF_8);
            var escaped = Pattern.quote(filename);
            projContent = projContent.replaceAll("(?m)^- " + escaped + "\\s*[—-].*\n?", "");
            Files.writeString(path, projContent, StandardCharsets.UTF_8);
            return Map.of("deleted", filename, "project", path.getParent().getFileName().toString());
        } catch (IOException e) {
            return Map.of("error", e.getMessage());
        }
    }


    // ── Private ──────────────────────────────────────────────────────────────────

    private static String slugify(String name) {
        return name.toLowerCase().strip().replaceAll("[^a-z0-9-]", "-").replaceAll("^-+|-+$", "");
    }

    private static Path findProject(String name) {
        var slug = slugify(name);
        var exact = PROJECTS_DIR.resolve(slug);
        if (Files.isDirectory(exact) && Files.exists(exact.resolve("project.md"))) {
            return exact.resolve("project.md");
        }
        if (!Files.exists(PROJECTS_DIR)) return null;
        try (Stream<Path> dirs = Files.list(PROJECTS_DIR)) {
            for (var d : dirs.toList()) {
                if (Files.isDirectory(d) && d.getFileName().toString().contains(slug)
                        && Files.exists(d.resolve("project.md"))) {
                    return d.resolve("project.md");
                }
            }
        } catch (IOException ignored) {}
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
