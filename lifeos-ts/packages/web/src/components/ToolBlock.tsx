'use client';

import { useState } from 'react';

interface ToolBlockProps {
  name: string;
  input?: Record<string, unknown>;
  result?: unknown;
  isPending?: boolean;
}

function getToolIcon(name: string): string {
  if (name.includes('bash') || name.includes('shell')) return '⚡';
  if (name.includes('search') || name.includes('web')) return '🔍';
  if (name.includes('file') || name.includes('read') || name.includes('write')) return '📄';
  if (name.includes('agent') || name.includes('message')) return '🤝';
  if (name.includes('browse')) return '🌐';
  if (name.includes('task') || name.includes('schedule')) return '📋';
  if (name.includes('log')) return '📝';
  if (name.includes('session')) return '💬';
  return '🔧';
}

export default function ToolBlock({ name, input, result, isPending }: ToolBlockProps) {
  const [inputExpanded, setInputExpanded] = useState(false);
  const [resultExpanded, setResultExpanded] = useState(false);

  const hasInput = input && Object.keys(input).length > 0;
  const hasResult = result !== undefined && result !== null;

  const formatJson = (val: unknown): string => {
    try {
      return JSON.stringify(val, null, 2);
    } catch {
      return String(val);
    }
  };

  return (
    <div className="tool-block">
      <div className="tool-block-header">
        <span className="tool-block-icon">{getToolIcon(name)}</span>
        <span className="tool-block-name">{name}</span>
        {isPending && <span className="loading-spinner" />}
        {hasInput && (
          <button
            className="tool-block-toggle"
            onClick={() => setInputExpanded(!inputExpanded)}
          >
            {inputExpanded ? 'hide input' : 'show input'}
          </button>
        )}
      </div>

      {hasInput && inputExpanded && (
        <div className="tool-block-section">
          <div className="tool-block-section-label">Input</div>
          <div className="tool-block-json">{formatJson(input)}</div>
        </div>
      )}

      {hasResult && (
        <div className="tool-block-section">
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
            onClick={() => setResultExpanded(!resultExpanded)}
          >
            <div className="tool-block-section-label" style={{ marginBottom: 0 }}>Result</div>
            <button className="tool-block-toggle">
              {resultExpanded ? 'collapse' : 'expand'}
            </button>
          </div>
          {resultExpanded && (
            <div className="tool-block-json" style={{ marginTop: 4 }}>
              {typeof result === 'string' ? result : formatJson(result)}
            </div>
          )}
          {!resultExpanded && (
            <div
              style={{
                fontSize: 11,
                color: 'var(--text-muted)',
                marginTop: 3,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                cursor: 'pointer',
              }}
              onClick={() => setResultExpanded(true)}
            >
              {typeof result === 'string'
                ? result.slice(0, 120)
                : formatJson(result).slice(0, 120)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
