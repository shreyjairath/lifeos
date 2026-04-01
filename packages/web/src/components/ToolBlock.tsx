'use client';

function toolSummary(name: string, input?: Record<string, unknown>): string {
  if (!input || Object.keys(input).length === 0) return `${name}()`;
  const priority = ['command', 'cmd', 'query', 'message', 'content', 'path', 'url', 'name', 'agent_name', 'task_id', 'session_id'];
  for (const key of priority) {
    if (input[key] !== undefined) {
      const val = String(input[key]);
      return `${name}(${val.length > 70 ? val.slice(0, 70) + '…' : val})`;
    }
  }
  const firstVal = String(Object.values(input)[0]);
  return `${name}(${firstVal.length > 70 ? firstVal.slice(0, 70) + '…' : firstVal})`;
}

interface ToolBlockProps {
  name: string;
  input?: Record<string, unknown>;
  result?: unknown;
  isPending?: boolean;
}

export default function ToolBlock({ name, input, result, isPending }: ToolBlockProps) {
  const summary = toolSummary(name, input);
  return (
    <div className="tool-block">
      ⚙ {summary}{isPending ? ' …' : result !== undefined ? ' ✓' : ''}
    </div>
  );
}
