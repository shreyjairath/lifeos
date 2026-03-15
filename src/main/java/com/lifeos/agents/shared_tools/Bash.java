package com.lifeos.agents.shared_tools;

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
            Pattern.compile(">>?\\s*/"),                                   // redirect to absolute path
            Pattern.compile("\\b(curl|wget|nc|netcat|ssh|scp|sftp)\\b"),  // network tools
            Pattern.compile("\\b(sudo|su)\\b"),                           // privilege escalation
            Pattern.compile("\\brm\\s+.*[/~]"));                          // rm targeting root/home

    private final Path cwd;

    public Bash(Path cwd) { this.cwd = cwd.normalize(); }

    public Map<String, Object> bash(String command) {
        for (var blocked : BLOCKED) {
            if (blocked.matcher(command).find())
                return Map.of("error", "Blocked command pattern: " + command);
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
