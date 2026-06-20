'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  fetchJournalEntries,
  fetchJournalEntry,
  createJournalEntry,
  updateJournalEntry,
  deleteJournalEntry,
} from '@/lib/api';
import type { JournalEntry } from '@/lib/types';

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export default function JournalPanel() {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadEntries = useCallback(async () => {
    const list = await fetchJournalEntries();
    setEntries(list);
  }, []);

  useEffect(() => { loadEntries(); }, [loadEntries]);

  const loadEntry = async (id: string) => {
    const entry = await fetchJournalEntry(id);
    if (entry) {
      setSelectedId(id);
      setContent(entry.content ?? '');
      setDirty(false);
    }
  };

  const handleNew = async () => {
    const entry = await createJournalEntry('');
    await loadEntries();
    setSelectedId(entry.id);
    setContent('');
    setDirty(false);
  };

  const handleContentChange = (val: string) => {
    setContent(val);
    setDirty(true);

    // Autosave after 1.5s of inactivity
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (selectedId) save(selectedId, val);
    }, 1500);
  };

  const save = async (id: string, val: string) => {
    setSaving(true);
    try {
      await updateJournalEntry(id, val);
      setDirty(false);
      await loadEntries();
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (selectedId) save(selectedId, content);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this entry?')) return;
    await deleteJournalEntry(id);
    if (selectedId === id) {
      setSelectedId(null);
      setContent('');
      setDirty(false);
    }
    await loadEntries();
  };

  const selected = entries.find(e => e.id === selectedId);

  return (
    <div className={`journal-layout${selectedId ? ' journal-layout--editing' : ''}`}>
      {/* Entry list */}
      <div className="journal-list">
        <div className="journal-list-header">
          <span className="journal-list-title">Journal</span>
          <button className="journal-new-btn" onClick={handleNew}>+ New</button>
        </div>
        {entries.length === 0 && (
          <div className="journal-empty">No entries yet.</div>
        )}
        {entries.map(e => (
          <div
            key={e.id}
            className={`journal-entry-item${selectedId === e.id ? ' active' : ''}`}
            onClick={() => loadEntry(e.id)}
          >
            <div className="journal-entry-title">{e.title}</div>
            <div className="journal-entry-date">{formatDate(e.date)}</div>
            {e.preview && <div className="journal-entry-preview">{e.preview}</div>}
            <button
              className="journal-entry-delete"
              title="Delete entry"
              onClick={ev => { ev.stopPropagation(); handleDelete(e.id); }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {/* Editor */}
      <div className="journal-editor">
        {selectedId ? (
          <>
            <div className="journal-editor-header">
              <button
                className="journal-back-btn"
                onClick={() => { setSelectedId(null); setContent(''); setDirty(false); }}
              >
                ← Back
              </button>
              <span className="journal-editor-date">{selected ? formatDate(selected.date) : ''}</span>
              <div className="journal-editor-actions">
                {saving && <span className="journal-save-status">Saving…</span>}
                {!saving && dirty && <span className="journal-save-status unsaved">Unsaved</span>}
                {!saving && !dirty && selectedId && <span className="journal-save-status saved">Saved</span>}
                <button className="journal-save-btn" onClick={handleSave} disabled={!dirty}>Save</button>
              </div>
            </div>
            <textarea
              className="journal-textarea"
              value={content}
              onChange={e => handleContentChange(e.target.value)}
              placeholder="Write anything…"
              spellCheck
            />
          </>
        ) : (
          <div className="journal-placeholder">
            <p>Select an entry or create a new one.</p>
            <button className="journal-new-btn-lg" onClick={handleNew}>+ New entry</button>
          </div>
        )}
      </div>
    </div>
  );
}
