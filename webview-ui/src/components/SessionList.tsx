import { useMemo, useState } from 'react';

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

interface SessionListProps {
  sessions: SessionMeta[];
  activeId: string;
  onNew: () => void;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

/**
 * Coarse on purpose. In a list sorted newest-first, "which one was that" is
 * answered by roughly when, not by a timestamp — and a precise one would be
 * wider than the title it sits beside.
 */
function ago(ts: number): string {
  const seconds = Math.max(0, (Date.now() - ts) / 1000);
  if (seconds < 60) return 'now';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = hours / 24;
  if (days < 7) return `${Math.floor(days)}d`;
  const weeks = days / 7;
  if (weeks < 5) return `${Math.floor(weeks)}w`;
  return `${Math.floor(days / 30)}mo`;
}

export function SessionList({
  sessions,
  activeId,
  onNew,
  onOpen,
  onRename,
  onDelete,
  onClose,
}: SessionListProps) {
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;
  }, [sessions, query]);

  function startRename(s: SessionMeta) {
    setEditingId(s.id);
    setDraft(s.title);
    setConfirmId(null);
  }

  function commitRename() {
    if (editingId) {
      onRename(editingId, draft);
    }
    setEditingId(null);
    setDraft('');
  }

  return (
    <div className="session-panel">
      <div className="session-head">
        <span className="session-head-title">Conversations</span>
        <button className="session-icon-btn" onClick={onClose} title="Close" aria-label="Close">
          ✕
        </button>
      </div>

      <button className="session-new-btn" onClick={onNew}>
        <span aria-hidden="true">+</span> New session
      </button>

      <input
        className="session-search"
        type="search"
        placeholder="Search sessions…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="session-scroll">
        {filtered.length === 0 && (
          <p className="session-empty">
            {sessions.length === 0 ? 'No conversations yet.' : 'Nothing matches that.'}
          </p>
        )}

        {filtered.map((s) => {
          const isActive = s.id === activeId;
          const isEditing = editingId === s.id;

          return (
            <div key={s.id} className={`session-row ${isActive ? 'session-row-active' : ''}`}>
              {isEditing ? (
                <input
                  className="session-rename-input"
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') {
                      setEditingId(null);
                      setDraft('');
                    }
                  }}
                />
              ) : (
                <button
                  className="session-open-btn"
                  onClick={() => onOpen(s.id)}
                  title={`${s.title} — ${s.messageCount} message${s.messageCount === 1 ? '' : 's'}`}
                >
                  <span className="session-title">{s.title}</span>
                  <span className="session-time">{ago(s.updatedAt)}</span>
                </button>
              )}

              {!isEditing && (
                <div className="session-row-actions">
                  <button
                    className="session-icon-btn"
                    onClick={() => startRename(s)}
                    title="Rename"
                    aria-label={`Rename ${s.title}`}
                  >
                    ✎
                  </button>
                  <button
                    className={`session-icon-btn ${confirmId === s.id ? 'session-icon-danger' : ''}`}
                    // Two clicks rather than a modal: deleting a transcript is
                    // not undoable, but it is also not worth a dialog every time.
                    onClick={() => {
                      if (confirmId === s.id) {
                        onDelete(s.id);
                        setConfirmId(null);
                      } else {
                        setConfirmId(s.id);
                      }
                    }}
                    onBlur={() => setConfirmId((c) => (c === s.id ? null : c))}
                    title={confirmId === s.id ? 'Click again to delete' : 'Delete'}
                    aria-label={`Delete ${s.title}`}
                  >
                    {confirmId === s.id ? '!' : '🗑'}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
