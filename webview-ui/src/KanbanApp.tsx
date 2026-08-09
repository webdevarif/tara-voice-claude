import { useState, useEffect } from 'react';
import { onExtensionMessage, postToExtension } from './vscode-api';
import './App.css';

interface KanbanCard {
  id: string;
  title: string;
  status: 'todo' | 'in_progress' | 'needs_input' | 'done' | 'error';
  agentPid?: number;
  startedAt?: number;
  completedAt?: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

interface KanbanBoard {
  cards: KanbanCard[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

const COLUMNS = [
  { id: 'todo',        label: 'To Do',       color: '#6b7280' },
  { id: 'in_progress', label: 'In Progress',  color: '#6366f1' },
  { id: 'needs_input', label: 'Needs Input',  color: '#f59e0b' },
  { id: 'done',        label: 'Done',         color: '#4ade80' },
  { id: 'error',       label: 'Error',        color: '#f87171' },
] as const;

type ColumnId = (typeof COLUMNS)[number]['id'];

const STATUS_ICON: Record<ColumnId, string> = {
  todo: '○',
  in_progress: '◌',
  needs_input: '◎',
  done: '●',
  error: '✕',
};

export default function KanbanApp() {
  const [board, setBoard] = useState<KanbanBoard>({
    cards: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
  });

  useEffect(() => {
    const cleanup = onExtensionMessage((msg) => {
      if (msg.type === 'KANBAN_UPDATE') {
        setBoard(msg.payload as KanbanBoard);
      }
    });
    return cleanup;
  }, []);

  const cardsByColumn = (col: ColumnId) =>
    board.cards.filter((c) => c.status === col);

  function stopAgent(id: string) {
    postToExtension({ type: 'STOP_AGENT', payload: { agentId: id } });
  }

  function elapsed(card: KanbanCard): string {
    if (!card.startedAt) return '';
    const end = card.completedAt ?? Date.now();
    const secs = Math.floor((end - card.startedAt) / 1000);
    if (secs < 60) return `${secs}s`;
    return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  }

  return (
    <div className="kanban-app">
      {/* Cost header */}
      <div className="kanban-header">
        <span className="kanban-title">Agent Board</span>
        <div className="kanban-cost">
          <span className="kanban-cost-label">Session cost</span>
          <span className="kanban-cost-value">
            ${board.totalCostUsd.toFixed(4)}
          </span>
          <span className="kanban-tokens">
            {((board.totalInputTokens + board.totalOutputTokens) / 1000).toFixed(1)}k tokens
          </span>
        </div>
      </div>

      {/* Empty state */}
      {board.cards.length === 0 && (
        <div className="kanban-empty">
          <div className="kanban-empty-icon">📋</div>
          <p className="kanban-empty-text">No agents running yet.</p>
          <p className="kanban-empty-sub">Send a command from the chat panel to start a task.</p>
        </div>
      )}

      {/* Columns */}
      {COLUMNS.filter((col) => cardsByColumn(col.id).length > 0).map((col) => (
        <div key={col.id} className="kanban-column">
          <div className="kanban-column-header">
            <span
              className="kanban-column-dot"
              style={{ background: col.color }}
            />
            <span className="kanban-column-label">{col.label}</span>
            <span className="kanban-column-count">{cardsByColumn(col.id).length}</span>
          </div>

          <div className="kanban-cards">
            {cardsByColumn(col.id).map((card) => (
              <div key={card.id} className={`kanban-card kanban-card-${card.status}`}>
                <div className="kanban-card-header">
                  <span className="kanban-card-icon" style={{ color: col.color }}>
                    {STATUS_ICON[col.id]}
                  </span>
                  <span className="kanban-card-title">{card.title}</span>
                  {(card.status === 'in_progress' || card.status === 'needs_input') && (
                    <button
                      className="kanban-stop-btn"
                      onClick={() => stopAgent(card.id)}
                      title="Stop this agent"
                      aria-label={`Stop agent: ${card.title}`}
                    >
                      ⏹
                    </button>
                  )}
                </div>
                <div className="kanban-card-meta">
                  {card.startedAt && (
                    <span className="kanban-meta-chip">{elapsed(card)}</span>
                  )}
                  {card.estimatedCostUsd > 0 && (
                    <span className="kanban-meta-chip kanban-cost-chip">
                      ${card.estimatedCostUsd.toFixed(4)}
                    </span>
                  )}
                  {card.status === 'in_progress' && (
                    <span className="kanban-spinner" />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
