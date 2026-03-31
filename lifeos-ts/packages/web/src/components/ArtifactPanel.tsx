'use client';

import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ArtifactFile {
  name: string;
  url: string;
}

interface ArtifactPanelProps {
  url: string | null;
  title: string;
  agent: string;
  onClose: () => void;
}

export default function ArtifactPanel({ url, title, agent, onClose }: ArtifactPanelProps) {
  const [files, setFiles] = useState<ArtifactFile[]>([]);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(url);
  const [selectedTitle, setSelectedTitle] = useState(title);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const isOpen = !!url;

  useEffect(() => {
    setSelectedUrl(url);
    setSelectedTitle(title);
  }, [url, title]);

  useEffect(() => {
    if (!agent || !isOpen) return;
    fetch(`/api/artifacts/${agent}`)
      .then(r => r.ok ? r.json() : [])
      .then(data => setFiles(Array.isArray(data) ? data : []))
      .catch(() => setFiles([]));
  }, [agent, isOpen]);

  useEffect(() => {
    if (!selectedUrl) return;
    const lower = selectedUrl.toLowerCase();
    const isHtml = lower.endsWith('.html') || lower.endsWith('.htm');
    if (!isHtml) {
      fetch(selectedUrl)
        .then(r => r.text())
        .then(t => setTextContent(t))
        .catch(() => setTextContent(null));
    } else {
      setTextContent(null);
    }
  }, [selectedUrl]);

  const isHtmlUrl = (u: string | null) => {
    if (!u) return false;
    const lower = u.toLowerCase();
    return lower.endsWith('.html') || lower.endsWith('.htm') || lower.includes('text/html');
  };

  return (
    <div className={`artifact-panel${isOpen ? ' open' : ''}`}>
      <div className="artifact-header">
        <span style={{ fontSize: 13 }}>📄</span>
        <span className="artifact-title">{selectedTitle || 'Artifact'}</span>
        <button
          className="icon-btn"
          title="Browse artifacts"
          onClick={() => setBrowserOpen(!browserOpen)}
        >
          📂
        </button>
        <button className="icon-btn" title="Close" onClick={onClose}>
          ✕
        </button>
      </div>

      {browserOpen && files.length > 0 && (
        <div
          style={{
            borderBottom: '1px solid var(--border)',
            padding: '8px 12px',
            background: 'var(--surface)',
            maxHeight: 140,
            overflowY: 'auto',
          }}
        >
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
            Artifacts
          </div>
          {files.map((f) => (
            <div
              key={f.url}
              style={{
                padding: '3px 6px',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 12,
                background: selectedUrl === f.url ? 'var(--accent-dim)' : 'none',
                color: selectedUrl === f.url ? 'var(--accent)' : 'var(--text)',
              }}
              onClick={() => {
                setSelectedUrl(f.url);
                setSelectedTitle(f.name);
                setBrowserOpen(false);
              }}
            >
              {f.name}
            </div>
          ))}
        </div>
      )}

      <div className="artifact-content">
        {selectedUrl && isHtmlUrl(selectedUrl) && (
          <iframe
            className="artifact-iframe"
            src={selectedUrl}
            sandbox="allow-scripts allow-same-origin"
            title={selectedTitle}
          />
        )}
        {selectedUrl && !isHtmlUrl(selectedUrl) && textContent !== null && (
          <div className="artifact-markdown">
            <div className="markdown-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {textContent}
              </ReactMarkdown>
            </div>
          </div>
        )}
        {!selectedUrl && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--text-muted)',
              fontSize: 13,
            }}
          >
            No artifact selected
          </div>
        )}
      </div>
    </div>
  );
}
