import { useEffect, useState } from 'react';
import { onExtensionMessage, postToExtension } from './vscode-api';
import './App.css';

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

interface KanbanCard {
  id: string;
  title: string;
  /** The untruncated instruction. `title` is the 60-character label. */
  prompt: string;
  /** Most recent tool line — what it is working on right now. */
  lastActivity?: string;
  toolCalls: number;
  status: 'todo' | 'in_progress' | 'needs_input' | 'done' | 'error';
  startedAt?: number;
  completedAt?: number;
  question?: string;
  usage: TokenUsage;
  costUsd: number;
  /** True once the figure came from the CLI rather than our own estimate. */
  costIsReported: boolean;
  model?: string;
}

interface KanbanBoard {
  cards: KanbanCard[];
  totalUsage: TokenUsage;
  totalCostUsd: number;
}

const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

const COLUMNS = [
  { id: 'todo', label: 'To Do', color: '#6b7280' },
  { id: 'in_progress', label: 'In Progress', color: '#6366f1' },
  { id: 'needs_input', label: 'Needs Input', color: '#f59e0b' },
  { id: 'done', label: 'Done', color: '#4ade80' },
  { id: 'error', label: 'Error', color: '#f87171' },
] as const;

type ColumnId = (typeof COLUMNS)[number]['id'];

const STATUS_ICON: Record<ColumnId, string> = {
  todo: '○',
  in_progress: '◌',
  needs_input: '◎',
  done: '●',
  error: '✕',
};

function totalTokens(u: TokenUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheCreationTokens + u.cacheReadTokens;
}

function formatTokens(count: number): string {
  if (count < 1000) {
    return `${count}`;
  }
  if (count < 1_000_000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return `${(count / 1_000_000).toFixed(2)}M`;
}

function formatCost(usd: number): string {
  if (usd === 0) {
    return '$0';
  }
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export default function KanbanApp() {
  const [board, setBoard] = useState<KanbanBoard>({
    cards: [],
    totalUsage: EMPTY_USAGE,
    totalCostUsd: 0,
  });
  // Drives the elapsed-time readout on running cards.
  const [, forceTick] = useState(0);

  useEffect(() => {
    const cleanup = onExtensionMessage((msg) => {
      if (msg.type === 'KANBAN_UPDATE') {
        const payload = msg.payload as Partial<KanbanBoard>;
        setBoard({
          cards: payload.cards ?? [],
          totalUsage: payload.totalUsage ?? EMPTY_USAGE,
          totalCostUsd: payload.totalCostUsd ?? 0,
        });
      }
    });
    // Asked for only after the handler is registered — an eager post from the
    // extension can land before this script has subscribed.
    postToExtension({ type: 'WEBVIEW_READY', payload: {} });
    return cleanup;
  }, []);

  const hasRunning = board.cards.some(
    (c) => c.status === 'in_progress' || c.status === 'needs_input'
  );

  useEffect(() => {
    if (!hasRunning) {
      return;
    }
    // Without this the "42s" on an in-progress card freezes until the next
    // board update, which can be many seconds apart.
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [hasRunning]);

  const cardsByColumn = (col: ColumnId) => board.cards.filter((c) => c.status === col);

  function stopAgent(id: string) {
    postToExtension({ type: 'STOP_AGENT', payload: { agentId: id } });
  }

  function elapsed(card: KanbanCard): string {
    if (!card.startedAt) {
      return '';
    }
    const end = card.completedAt ?? Date.now();
    const secs = Math.max(0, Math.floor((end - card.startedAt) / 1000));
    if (secs < 60) {
      return `${secs}s`;
    }
    return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  }

  const total = totalTokens(board.totalUsage);

  return (
    <div className="kanban-app">
      <div className="kanban-header">
        <span className="kanban-title">Agent Board</span>
        <div className="kanban-cost">
          <span className="kanban-cost-label">Session cost</span>
          <span className="kanban-cost-value">{formatCost(board.totalCostUsd)}</span>
          <span className="kanban-tokens">{formatTokens(total)} tokens</span>
        </div>
      </div>

      {board.cards.length === 0 && (
        <div className="kanban-empty">
          <div className="kanban-empty-icon">📋</div>
          <p className="kanban-empty-text">No agents running yet.</p>
          <p className="kanban-empty-sub">
            Send a command from the chat panel to start a task.
          </p>
        </div>
      )}

      {COLUMNS.filter((col) => cardsByColumn(col.id).length > 0).map((col) => (
        <div key={col.id} className="kanban-column">
          <div className="kanban-column-header">
            <span className="kanban-column-dot" style={{ background: col.color }} />
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
                  {/* The full prompt on hover: the cheapest possible answer to
                      "what was this actually asked to do", given the visible
                      title is cut at 60 characters. */}
                  <span className="kanban-card-title" title={card.prompt || card.title}>
                    {card.title}
                  </span>
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

                {card.status === 'needs_input' && card.question && (
                  <p className="kanban-card-question">{card.question}</p>
                )}

                {/* What it is doing, not just that it is doing something. Elapsed
                    time already says a task is running; this says what it is
                    running on, which is the question the board could not answer. */}
                {card.status === 'in_progress' && card.lastActivity && (
                  <p className="kanban-card-activity" title={card.lastActivity}>
                    <span className="kanban-activity-arrow" aria-hidden="true">
                      ↳
                    </span>
                    {card.lastActivity}
                  </p>
                )}

                <div className="kanban-card-meta">
                  {card.startedAt && (
                    <span className="kanban-meta-chip">{elapsed(card)}</span>
                  )}
                  {card.costUsd > 0 && (
                    <span
                      className="kanban-meta-chip kanban-cost-chip"
                      title={
                        card.costIsReported
                          ? 'Reported by Claude Code'
                          : 'Estimate — final figure arrives when the task finishes'
                      }
                    >
                      {card.costIsReported ? '' : '~'}
                      {formatCost(card.costUsd)}
                    </span>
                  )}
                  {card.model && <span className="kanban-meta-chip">{card.model}</span>}
                  {card.status === 'in_progress' && <span className="kanban-spinner" />}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
