package com.lifeos.executor;

import com.lifeos.tools.*;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/**
 * Tool definitions (Anthropic format) and dispatch routing.
 */
@Component
public class ToolsRegistry {

    private final FileSystem fileSystem;
    private final KnowledgeFiles knowledgeFiles;
    private final Projects projects;
    private final WebSearch webSearch;
    private final Browse browse;
    private final Media media;
    private final Redfin redfin;
    private final PropertyReport propertyReport;

    public ToolsRegistry(
            FileSystem fileSystem, KnowledgeFiles knowledgeFiles, Projects projects,
            WebSearch webSearch, Browse browse, Media media, Redfin redfin,
            PropertyReport propertyReport
    ) {
        this.fileSystem = fileSystem;
        this.knowledgeFiles = knowledgeFiles;
        this.projects = projects;
        this.webSearch = webSearch;
        this.browse = browse;
        this.media = media;
        this.redfin = redfin;
        this.propertyReport = propertyReport;
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> dispatch(String toolName, Map<String, Object> input) {
        return switch (toolName) {
            // Projects
            case "create_project" -> projects.create(
                    (String) input.get("name"), (String) input.get("goal"),
                    (String) input.getOrDefault("context", ""));
            case "list_projects" -> projects.list();
            case "update_project" -> projects.update(
                    (String) input.get("name"), (String) input.get("section"), (String) input.get("content"));
            case "read_project" -> projects.read((String) input.get("name"));
            case "add_project_file" -> projects.addFile(
                    projName(input), (String) input.get("filename"),
                    (String) input.getOrDefault("description", ""), (String) input.getOrDefault("content", ""));
            case "read_project_file" -> projects.readFile(projName(input), (String) input.get("filename"));
            case "update_project_file" -> projects.updateFile(
                    projName(input), (String) input.get("filename"), (String) input.getOrDefault("content", ""));
            case "delete_project_file" -> projects.deleteFile(projName(input), (String) input.get("filename"));

            // Knowledge
            case "read_knowledge" -> knowledgeFiles.read((String) input.get("file"));
            case "update_knowledge" -> knowledgeFiles.update((String) input.get("file"), (String) input.get("content"));
            case "set_onboarding_status" -> knowledgeFiles.setOnboardingStatus(
                    (String) input.get("file"), (String) input.get("status"));

            // Filesystem
            case "write_file" -> fileSystem.writeFile((String) input.get("path"), (String) input.get("content"));
            case "read_file" -> fileSystem.readFile((String) input.get("path"));
            case "update_file" -> fileSystem.updateFile(
                    (String) input.get("path"), (String) input.get("old_str"), (String) input.get("new_str"));
            case "list_dir" -> fileSystem.listDir((String) input.getOrDefault("path", "."));

            // Web
            case "web_search" -> webSearch.search((String) input.get("query"));
            case "browse_page" -> browse.fetch((String) input.get("url"));
            case "parse_redfin_listing" -> redfin.parseListing((String) input.get("url"));
            case "parse_redfin_search" -> redfin.parseSearch((String) input.get("url"));
            case "property_report" -> propertyReport.report((String) input.get("address"));

            // Media
            case "show_image" -> media.showImage((String) input.get("url"), (String) input.getOrDefault("caption", ""));

            default -> Map.of("error", "Unknown tool: " + toolName);
        };
    }

    public List<Map<String, Object>> getTools() {
        return TOOLS;
    }


    // ── Helpers ──────────────────────────────────────────────────────────────────

    private static String projName(Map<String, Object> input) {
        var name = input.get("project");
        if (name == null) name = input.get("name");
        return (String) name;
    }


    // ── Tool definitions ─────────────────────────────────────────────────────────

    private static final List<Map<String, Object>> TOOLS = List.of(
            tool("create_project",
                    "Create a new project with a goal and optional context.",
                    props(
                            prop("name", "string", "Short project name"),
                            prop("goal", "string", "What success looks like"),
                            prop("context", "string", "Background, constraints (optional)")
                    ), "name", "goal"),
            tool("list_projects", "List all active projects with their status and goals.",
                    props(), new String[]{}),
            tool("update_project",
                    "Update a specific section of a project.",
                    props(
                            prop("name", "string", "Project name or slug"),
                            propEnum("section", List.of("context", "snapshot", "next_action", "waiting_on", "files", "log"), "Which section"),
                            prop("content", "string", "New content for the section")
                    ), "name", "section", "content"),
            tool("read_project", "Read the full details of a specific project.",
                    props(prop("name", "string", "Project name or slug")), "name"),
            tool("add_project_file",
                    "Attach a named document to a project.",
                    props(
                            prop("name", "string", "Project name or slug"),
                            prop("filename", "string", "Document name"),
                            prop("description", "string", "One-line description"),
                            prop("content", "string", "Full document content")
                    ), "name", "filename", "description", "content"),
            tool("read_project_file", "Read a document attached to a project.",
                    props(prop("name", "string", "Project name"), prop("filename", "string", "Document name")),
                    "name", "filename"),
            tool("update_project_file", "Overwrite a project document.",
                    props(prop("name", "string", "Project name"), prop("filename", "string", "Document name"),
                            prop("content", "string", "New content")),
                    "name", "filename", "content"),
            tool("delete_project_file", "Remove a document from a project.",
                    props(prop("name", "string", "Project name"), prop("filename", "string", "Document name")),
                    "name", "filename"),
            tool("browse_page",
                    "Fetch and read the content of a web page.",
                    props(prop("url", "string", "Full URL to fetch")), "url"),
            tool("parse_redfin_listing",
                    "Parse a Redfin listing URL and return structured property data: price, beds/baths, sq ft, HOA, year built, amenities, coordinates, MLS number, description, and photo URLs.",
                    props(prop("url", "string", "Redfin listing URL")), "url"),
            tool("parse_redfin_search",
                    "Parse a Redfin search results page and return all listed properties with price, beds, baths, sq ft, and URL. " +
                    "IMPORTANT: Use zipcode URLs (e.g. redfin.com/zipcode/60614/filter/...) — neighborhood URLs (/neighborhood/...) do not work and return wrong results. " +
                    "Filters can be appended: /filter/property-type=condo,min-beds=2,max-price=700k",
                    props(prop("url", "string", "Redfin zipcode or city search URL (e.g. redfin.com/zipcode/60614 or redfin.com/city/6331/IL/Chicago). Do NOT use /neighborhood/ URLs.")), "url"),
            tool("property_report",
                    "Generate a comprehensive property report for any address. Includes building obstruction analysis (distances to adjacent buildings in each cardinal direction), sun exposure, corner unit detection, floor number, street noise, neighborhood walkability, transit access, parks, flood zone, and elevation. Best used before evaluating a condo or apartment.",
                    props(prop("address", "string", "Full street address including unit number if applicable (e.g. '123 Main St #4N, Chicago, IL')")),
                    "address"),
            tool("web_search",
                    "Search the web for information.",
                    props(prop("query", "string", "Search query")), "query"),
            tool("read_knowledge", "Read a knowledge base file.",
                    props(propEnum("file", List.of("identity", "routines", "environment"), "Which file")),
                    "file"),
            tool("update_knowledge", "Update a knowledge base file.",
                    props(
                            propEnum("file", List.of("identity", "routines", "environment"), "Which file"),
                            prop("content", "string", "Full new content")
                    ), "file", "content"),
            tool("set_onboarding_status", "Mark a knowledge area as done or pending.",
                    props(
                            propEnum("file", List.of("identity", "routines", "environment"), "Knowledge area"),
                            propEnum("status", List.of("pending", "done"), "New status")
                    ), "file", "status"),
            tool("write_file", "Create or overwrite a file under .user-data/.",
                    props(prop("path", "string", "Relative path"), prop("content", "string", "File content")),
                    "path", "content"),
            tool("read_file", "Read a file under .user-data/.",
                    props(prop("path", "string", "Relative path")), "path"),
            tool("update_file", "Edit a file by replacing a specific string.",
                    props(prop("path", "string", "Relative path"), prop("old_str", "string", "String to find"),
                            prop("new_str", "string", "Replacement")),
                    "path", "old_str", "new_str"),
            tool("list_dir", "List files and subdirectories.",
                    props(prop("path", "string", "Relative path (defaults to root)")), new String[]{}),
            tool("show_image", "Display an image inline in the chat.",
                    props(prop("url", "string", "Image URL"), prop("caption", "string", "Optional caption")),
                    "url")
    );


    // ── Definition builders ──────────────────────────────────────────────────────

    private static Map<String, Object> tool(String name, String description,
                                             Map<String, Object> properties, String... required) {
        var schema = new java.util.LinkedHashMap<String, Object>();
        schema.put("type", "object");
        schema.put("properties", properties);
        if (required.length > 0) {
            schema.put("required", List.of(required));
        }
        return Map.of("name", name, "description", description, "input_schema", schema);
    }

    private static Map<String, Object> props(Map.Entry<String, Map<String, Object>>... entries) {
        var map = new java.util.LinkedHashMap<String, Object>();
        for (var entry : entries) {
            map.put(entry.getKey(), entry.getValue());
        }
        return map;
    }

    private static Map.Entry<String, Map<String, Object>> prop(String name, String type, String description) {
        return Map.entry(name, Map.of("type", type, "description", description));
    }

    private static Map.Entry<String, Map<String, Object>> propEnum(String name, List<String> values, String description) {
        return Map.entry(name, Map.of("type", "string", "enum", values, "description", description));
    }
}
