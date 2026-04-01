'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import ToolBlock from './ToolBlock';
import type { Message } from '@/lib/types';

interface MessageBubbleProps {
  message: Message;
}

export default function MessageBubble({ message }: MessageBubbleProps) {
  if (message.role === 'thinking') {
    return (
      <div className="msg">
        <details className="reasoning-block">
          <summary>Reasoning</summary>
          <div className="reasoning-content">{message.text}</div>
        </details>
      </div>
    );
  }

  if (message.role === 'tool') {
    return (
      <div className="msg">
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
        <div className="bubble">
          <span style={{ whiteSpace: 'pre-wrap' }}>{message.text}</span>
        </div>
      </div>
    );
  }

  // agent — don't render if no text
  if (!message.text) return null;

  return (
    <div className="msg agent">
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
