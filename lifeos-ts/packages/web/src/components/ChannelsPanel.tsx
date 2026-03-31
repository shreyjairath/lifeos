'use client';

import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fetchChannels, fetchChannelContent } from '@/lib/api';
import type { Channel } from '@/lib/types';

export default function ChannelsPanel() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selected, setSelected] = useState<Channel | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchChannels().then(setChannels).catch(() => setChannels([]));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    fetchChannelContent(selected.pair)
      .then(c => { setContent(c); setLoading(false); })
      .catch(() => { setContent(''); setLoading(false); });
  }, [selected]);

  return (
    <div className="channels-layout">
      <div className="channels-list">
        {channels.length === 0 && (
          <div className="text-sm text-muted" style={{ padding: '8px 4px' }}>
            No channels yet
          </div>
        )}
        {channels.map(ch => (
          <div
            key={ch.pair}
            className={`channel-item${selected?.pair === ch.pair ? ' active' : ''}`}
            onClick={() => setSelected(ch)}
          >
            <div className="channel-agents">
              {ch.agents.map(a => (
                <span key={a} className="channel-agent-tag">{a}</span>
              ))}
            </div>
            {ch.preview && (
              <div className="channel-item-preview">{ch.preview}</div>
            )}
          </div>
        ))}
      </div>

      <div className="channel-content">
        {!selected && (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            Select a channel to view the conversation log.
          </div>
        )}
        {selected && loading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)' }}>
            <span className="loading-spinner" /> Loading...
          </div>
        )}
        {selected && !loading && content && (
          <div className="markdown-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        )}
        {selected && !loading && !content && (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Empty channel.</div>
        )}
      </div>
    </div>
  );
}
