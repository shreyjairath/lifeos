'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import ToolBlock from './ToolBlock';
import type { Message } from '@/lib/types';

interface MessageBubbleProps {
  message: Message;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function MessageBubble({ message }: MessageBubbleProps) {
  if (message.role === 'thinking') {
    return (
      <div className="message thinking">
        <details className="thinking-block">
          <summary className="thinking-summary">
            <span>🧠</span>
            <span>Reasoning</span>
          </summary>
          <div className="thinking-content">{message.text}</div>
        </details>
      </div>
    );
  }

  if (message.role === 'tool') {
    return (
      <div className="message tool">
        <ToolBlock
          name={message.toolName ?? 'tool'}
          input={message.toolInput}
          result={message.toolResult}
          isPending={!message.toolResult && !message.text.includes('result')}
        />
        <div className="message-meta">{formatTime(message.timestamp)}</div>
      </div>
    );
  }

  if (message.role === 'user') {
    return (
      <div className="message user">
        <div className="message-bubble">
          <span style={{ whiteSpace: 'pre-wrap' }}>{message.text}</span>
        </div>
        <div className="message-meta">{formatTime(message.timestamp)}</div>
      </div>
    );
  }

  // agent
  return (
    <div className="message agent">
      <div className={`message-bubble${message.isStreaming ? ' streaming-cursor' : ''}`}>
        <div className="markdown-content">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
          >
            {message.text || ''}
          </ReactMarkdown>
        </div>
      </div>
      <div className="message-meta">{formatTime(message.timestamp)}</div>
    </div>
  );
}
