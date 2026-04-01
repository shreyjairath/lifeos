const GATED_TOOLS = new Set(['run_python', 'claude_code', 'chrome_open', 'chrome_click', 'chrome_type', 'chrome_screenshot']);
const TIMEOUT_MS = 120_000;

interface PendingConfirmation {
  resolve: (approved: boolean) => void;
  promise: Promise<boolean>;
  timer: ReturnType<typeof setTimeout>;
}

export class Confirmations {
  private pending = new Map<string, PendingConfirmation>();

  isGated(toolName: string): boolean {
    return GATED_TOOLS.has(toolName);
  }

  register(): { requestId: string; promise: Promise<boolean> } {
    const requestId = crypto.randomUUID();
    let resolve!: (approved: boolean) => void;
    const promise = new Promise<boolean>((r) => { resolve = r; });
    const timer = setTimeout(() => {
      resolve(false);
      this.pending.delete(requestId);
    }, TIMEOUT_MS);
    this.pending.set(requestId, { resolve, promise, timer });
    return { requestId, promise };
  }

  resolve(requestId: string, approved: boolean): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    entry.resolve(approved);
    this.pending.delete(requestId);
    return true;
  }
}
