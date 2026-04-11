import { spawnSync } from 'child_process';
import { resolve, normalize } from 'path';

const BLOCKED: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\.\.\//,                                         reason: 'Path traversal not allowed. Use relative paths from your workspace root.' },
  { pattern: /(?<!\d)>>?\s*\//,                                reason: 'Redirect to absolute path not allowed. Use a relative path (e.g. > file.md).' },
  { pattern: /\b(curl|wget|nc|netcat|ssh|scp|sftp)\b/,        reason: 'Network tools are not available in agent_bash.' },
  { pattern: /\b(sudo|su)\b/,                                  reason: 'Privilege escalation not allowed.' },
  { pattern: /\brm\s+.*[/~]/,                                  reason: 'rm targeting root or home not allowed.' },
  { pattern: /\.user-data\//,                                  reason: 'Direct .user-data access not allowed.' },
  { pattern: /~[/\s]|^~$|(?<=[\s;|&`])~(?=[/\s]|$)/,         reason: 'Tilde home expansion not allowed. Use relative paths.' },
  { pattern: /\$HOME/,                                         reason: '$HOME not allowed. Use relative paths.' },
  { pattern: /(?:^|[\s;|&`"'])\/(?!dev\/null)[a-zA-Z]/,       reason: 'Absolute paths not allowed. Your workspace is the current directory — use relative paths.' },
  { pattern: /<<-?\s*['"]?[A-Z_]+['"]?/,                      reason: 'Heredoc syntax is unreliable. Use printf instead: printf "line1\\nline2\\n" > file.md' },
];

const WRITE_OPS = [
  /\b(rm|mv|cp|mkdir|touch|chmod|chown|tee|truncate|ln)\b/,
  />>?\s*\S/,                                        // output redirects
  /\b(echo|printf|cat|sed|awk|python3|python|perl|ruby|node)\b.*>/,
  /\b(write|append|create|delete|remove)\b/,
];

export class Bash {
  private readonly cwd: string;
  private readonly readonly: boolean;

  constructor(workspacePath: string, readonly_: boolean = false) {
    this.cwd = normalize(resolve(workspacePath));
    this.readonly = readonly_;
  }

  run(command: string): Record<string, any> {
    if (!command?.trim()) return { error: 'No command provided' };

    for (const { pattern, reason } of BLOCKED) {
      if (pattern.test(command)) {
        return { error: reason };
      }
    }

    if (this.readonly) {
      for (const pattern of WRITE_OPS) {
        if (pattern.test(command)) {
          return { error: `This workspace is read-only: ${command}` };
        }
      }
    }

    try {
      const result = spawnSync('bash', ['-c', command], {
        cwd: this.cwd,
        encoding: 'utf-8',
        timeout: 30_000,
        maxBuffer: 5 * 1024 * 1024,
      });

      if (result.error) {
        if ((result.error as any).code === 'ETIMEDOUT') {
          return { error: 'Command timed out after 30s' };
        }
        return { error: `exec failed: ${result.error.message}` };
      }

      const raw = (result.stdout ?? '') + (result.stderr ?? '');
      const MAX_CHARS = 15_000;
      const output = raw.length > MAX_CHARS
        ? raw.slice(0, MAX_CHARS) +
          `\n[...truncated at ${MAX_CHARS} chars (${raw.length} total). Use \`sed -n 'N,Mp' file\` to read a specific line range.]`
        : raw;
      return { output, exit_code: result.status ?? 0 };
    } catch (err: any) {
      return { error: `exec failed: ${err?.message ?? 'unknown'}` };
    }
  }
}
