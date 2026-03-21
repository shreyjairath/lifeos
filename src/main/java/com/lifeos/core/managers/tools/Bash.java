package com.lifeos.core.managers.tools;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * Scoped bash execution tool. Runs commands in a fixed working directory.
 * Not a Spring component — instantiated per-agent with their desired cwd.
 */
public class Bash {

    private static final List<Pattern> BLOCKED = List.of(
            Pattern.compile("\\.\\./"),                                    // path traversal
            Pattern.compile("(?<!\\d)>>?\\s*/"),                             // redirect to absolute path (not 2>/dev/null)
            Pattern.compile("\\b(curl|wget|nc|netcat|ssh|scp|sftp)\\b"),  // network tools
            Pattern.compile("\\b(sudo|su)\\b"),                           // privilege escalation
            Pattern.compile("\\brm\\s+.*[/~]"),                           // rm targeting root/home
            Pattern.compile("\\.user-data/"),                              // must not reference parent dirs
            Pattern.compile("~[/\\s]|^~$|(?<=[\\s;|&`])~(?=[/\\s]|$)"),  // tilde home expansion
            Pattern.compile("\\$HOME"));                                   // explicit $HOME reference

    private static final List<Pattern> WRITE_OPS = List.of(
            Pattern.compile("\\b(rm|mv|cp|mkdir|touch|chmod|chown|tee|truncate|ln)\\b"),
            Pattern.compile(">>?\\s*\\S"),                                 // output redirects
            Pattern.compile("\\b(echo|printf|cat|sed|awk|python3|python|perl|ruby|node)\\b.*>"),
            Pattern.compile("\\b(write|append|create|delete|remove)\\b")); // common write verbs in scripts

    private final Path cwd;
    private final boolean readonly;

    public Bash(Path cwd) { this(cwd, false); }

    public Bash(Path cwd, boolean readonly) {
        this.cwd = cwd.normalize();
        this.readonly = readonly;
    }

    public Map<String, Object> bash(String command) {
        for (var blocked : BLOCKED) {
            if (blocked.matcher(command).find())
                return Map.of("error", "Blocked command pattern: " + command);
        }
        if (readonly) {
            for (var write : WRITE_OPS) {
                if (write.matcher(command).find())
                    return Map.of("error", "This workspace is read-only: " + command);
            }
        }
        try {
            var proc = new ProcessBuilder("bash", "-c", command)
                    .directory(cwd.toFile())
                    .redirectErrorStream(true)
                    .start();
            var output = new String(proc.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            boolean finished = proc.waitFor(30, TimeUnit.SECONDS);
            if (!finished) {
                proc.destroyForcibly();
                return Map.of("error", "Command timed out after 30s");
            }
            return Map.of("output", output, "exit_code", proc.exitValue());
        } catch (IOException | InterruptedException e) {
            return Map.of("error", "exec failed: " + e.getMessage());
        }
    }
}
