import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, normalize, relative, resolve } from 'path';

const MAX_CHARS = 100_000;

export class FileTools {
  private readonly workspace: string;

  constructor(workspacePath: string) {
    this.workspace = normalize(resolve(workspacePath));
  }

  private resolveSafe(path: string): string | null {
    if (!path || /\.\.\//.test(path) || /^\//.test(path)) return null;
    const resolved = normalize(resolve(this.workspace, path));
    return resolved.startsWith(this.workspace) ? resolved : null;
  }

  read(path: string, offset?: number, length?: number): Record<string, any> {
    const start = offset ?? 0;
    const size = length ?? MAX_CHARS;
    const resolved = this.resolveSafe(path);
    if (!resolved) return { error: 'Invalid path: must be a relative path within your workspace (no ../ or absolute paths).' };
    if (!existsSync(resolved)) return { error: `File not found: ${path}` };
    try {
      const raw = readFileSync(resolved, 'utf-8');
      const chunk = raw.slice(start, start + size);
      const remaining = raw.length - (start + chunk.length);
      const result: Record<string, any> = { content: chunk, total_chars: raw.length };
      if (remaining > 0) result.remaining_chars = remaining;
      return result;
    } catch (err: any) {
      return { error: `Failed to read file: ${err?.message ?? 'unknown'}` };
    }
  }

  patch(path: string, oldString: string, newString: string): Record<string, any> {
    const resolved = this.resolveSafe(path);
    if (!resolved) return { error: 'Invalid path: must be a relative path within your workspace (no ../ or absolute paths).' };
    if (!existsSync(resolved)) return { error: `File not found: ${path}` };
    try {
      const raw = readFileSync(resolved, 'utf-8');
      const idx = raw.indexOf(oldString);
      if (idx === -1) return { error: 'old_string not found in file — make sure it matches exactly, including whitespace and newlines.' };
      const count = raw.split(oldString).length - 1;
      if (count > 1) return { error: `old_string matches ${count} locations — provide more surrounding context to make it unique.` };
      const updated = raw.slice(0, idx) + newString + raw.slice(idx + oldString.length);
      writeFileSync(resolved, updated, 'utf-8');
      // Return ~3 lines of context around the patched region so the agent can verify without re-reading
      const CONTEXT_CHARS = 200;
      const start = Math.max(0, idx - CONTEXT_CHARS);
      const end = Math.min(updated.length, idx + newString.length + CONTEXT_CHARS);
      const snippet = (start > 0 ? '…' : '') + updated.slice(start, end) + (end < updated.length ? '…' : '');
      return { patched: true, path: relative(this.workspace, resolved), snippet };
    } catch (err: any) {
      return { error: `Failed to patch file: ${err?.message ?? 'unknown'}` };
    }
  }

  append(path: string, content: string): Record<string, any> {
    const resolved = this.resolveSafe(path);
    if (!resolved) return { error: 'Invalid path: must be a relative path within your workspace (no ../ or absolute paths).' };
    try {
      mkdirSync(dirname(resolved), { recursive: true });
      const existing = existsSync(resolved) ? readFileSync(resolved, 'utf-8') : '';
      const joined = existing.endsWith('\n') || existing === '' ? existing + content : existing + '\n' + content;
      writeFileSync(resolved, joined, 'utf-8');
      return { appended: true, path: relative(this.workspace, resolved), total_chars: joined.length };
    } catch (err: any) {
      return { error: `Failed to append to file: ${err?.message ?? 'unknown'}` };
    }
  }

  write(path: string, content: string): Record<string, any> {
    const resolved = this.resolveSafe(path);
    if (!resolved) return { error: 'Invalid path: must be a relative path within your workspace (no ../ or absolute paths).' };
    try {
      mkdirSync(dirname(resolved), { recursive: true });
      writeFileSync(resolved, content, 'utf-8');
      return { written: true, path: relative(this.workspace, resolved) };
    } catch (err: any) {
      return { error: `Failed to write file: ${err?.message ?? 'unknown'}` };
    }
  }
}
