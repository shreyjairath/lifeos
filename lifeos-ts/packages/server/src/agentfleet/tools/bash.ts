import { spawnSync } from 'child_process';
import { resolve, normalize } from 'path';

const BLOCKED = [
  /\.\.\//,                                          // path traversal
  /(?<!\d)>>?\s*\//,                                 // redirect to absolute path
  /\b(curl|wget|nc|netcat|ssh|scp|sftp)\b/,          // network tools
  /\b(sudo|su)\b/,                                   // privilege escalation
  /\brm\s+.*[/~]/,                                   // rm targeting root/home
  /\.user-data\//,                                   // must not reference parent dirs
  /~[/\s]|^~$|(?<=[\s;|&`])~(?=[/\s]|$)/,           // tilde home expansion
  /\$HOME/,                                          // explicit $HOME reference
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

    for (const pattern of BLOCKED) {
      if (pattern.test(command)) {
        return { error: `Blocked command pattern: ${command}` };
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

      const output = (result.stdout ?? '') + (result.stderr ?? '');
      return { output, exit_code: result.status ?? 0 };
    } catch (err: any) {
      return { error: `exec failed: ${err?.message ?? 'unknown'}` };
    }
  }
}
