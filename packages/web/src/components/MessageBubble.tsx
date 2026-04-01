'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import ToolBlock from './ToolBlock';
import type { Message } from '@/lib/types';

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface MessageBubbleProps {
  message: Message;
  agentName?: string;
  showLabel?: boolean;
}

export default function MessageBubble({ message, agentName, showLabel = true }: MessageBubbleProps) {
  if (message.role === 'thinking') {
    return (
      <div className="msg thinking">
        {agentName && showLabel && (
          <div className="msg-label">
            <span>{agentName}</span>
            <span>{formatTime(message.timestamp)}</span>
          </div>
        )}
        <details className="reasoning-block">
          <summary>
            Reasoning{message.isStreaming && <span className="reasoning-streaming-dot" />}
          </summary>
          <div className="reasoning-content">{message.text}</div>
        </details>
      </div>
    );
  }

  if (message.role === 'tool') {
    return (
      <div className="msg tool">
        <ToolBlock
          name={message.toolName ?? 'tool'}
          input={message.toolInput}
          result={message.toolResult}
          isPending={!message.toolResult}
        />
      </div>
    );
  }

  if (message.role === 'user') {
    return (
      <div className="msg user">
        <div className="msg-label">
          <span>You</span>
          <span>{formatTime(message.timestamp)}</span>
        </div>
        <div className="bubble">
          <span style={{ whiteSpace: 'pre-wrap' }}>{message.text}</span>
        </div>
      </div>
    );
  }

  // agent — don't render if no text and not streaming
  if (!message.text && !message.isStreaming) return null;

  return (
    <div className="msg agent">
      {showLabel && (
        <div className="msg-label">
          {agentName && <span>{agentName}</span>}
          <span>{formatTime(message.timestamp)}</span>
        </div>
      )}
      <div className={`bubble${message.isStreaming ? ' streaming-cursor' : ''}`}>
        <div className="markdown-content">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
          >
            {message.text || ''}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
