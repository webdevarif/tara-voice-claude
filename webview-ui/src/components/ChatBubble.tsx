interface ChatEntry {
  id: string;
  role: 'user' | 'tara' | 'claude' | 'system';
  content: string;
  timestamp: number;
  streaming?: boolean;
}

interface ChatBubbleProps {
  entry: ChatEntry;
}

const ROLE_META = {
  user:   { label: 'You',    className: 'bubble-user'   },
  tara:   { label: 'Tara',   className: 'bubble-tara'   },
  claude: { label: 'Claude', className: 'bubble-claude' },
  system: { label: '',       className: 'bubble-system' },
} as const;

export function ChatBubble({ entry }: ChatBubbleProps) {
  const meta = ROLE_META[entry.role];

  if (entry.role === 'system') {
    return (
      <div className={`chat-bubble ${meta.className}`}>
        <span className="bubble-system-text">{entry.content}</span>
      </div>
    );
  }

  return (
    <div className={`chat-bubble ${meta.className}`}>
      <div className="bubble-header">
        <span className="bubble-label">{meta.label}</span>
        <span className="bubble-time">
          {new Date(entry.timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
        {entry.streaming && (
          <span className="bubble-streaming-dot" title="Streaming…" />
        )}
      </div>
      <div className="bubble-content">{formatContent(entry.content)}</div>
    </div>
  );
}

function formatContent(text: string): React.ReactNode {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts.map((part, i) => {
    if (part.startsWith('```')) {
      const lines = part.split('\n');
      const lang = lines[0].replace('```', '').trim();
      const code = lines.slice(1, -1).join('\n');
      return (
        <pre key={i} className="bubble-code">
          {lang && <span className="bubble-code-lang">{lang}</span>}
          <code>{code}</code>
        </pre>
      );
    }
    const inlineParts = part.split(/(`[^`]+`)/g);
    return (
      <span key={i}>
        {inlineParts.map((inline, j) =>
          inline.startsWith('`') ? (
            <code key={j} className="bubble-inline-code">
              {inline.slice(1, -1)}
            </code>
          ) : (
            <span key={j}>{inline}</span>
          )
        )}
      </span>
    );
  });
}
