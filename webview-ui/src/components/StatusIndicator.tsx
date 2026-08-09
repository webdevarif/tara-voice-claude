interface StatusIndicatorProps {
  status: 'idle' | 'running' | 'waiting_for_input' | 'done' | 'error';
}

const STATUS_META = {
  idle: { label: 'Ready', color: 'var(--status-idle)', pulse: false },
  running: { label: 'Working…', color: 'var(--status-running)', pulse: true },
  waiting_for_input: { label: 'Needs input', color: 'var(--status-waiting)', pulse: true },
  done: { label: 'Done', color: 'var(--status-done)', pulse: false },
  error: { label: 'Error', color: 'var(--status-error)', pulse: false },
} as const;

export function StatusIndicator({ status }: StatusIndicatorProps) {
  const meta = STATUS_META[status];
  return (
    <div className="status-indicator" role="status" aria-live="polite">
      <span
        className={`status-dot ${meta.pulse ? 'pulse' : ''}`}
        style={{ background: meta.color }}
      />
      <span className="status-label">{meta.label}</span>
    </div>
  );
}
