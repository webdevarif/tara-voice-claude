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

declare global {
  interface Window {
    /**
     * Injected by the extension host. The avatars have to be bundled and handed
     * over as webview URIs — the panel's CSP allows `img-src` only from
     * cspSource and data:, so a remote URL is blocked outright.
     */
    __taraAvatars?: { me?: string; claude?: string };
  }
}

const ROLE_META = {
  user:   { label: 'You',    className: 'bubble-user',   rowClass: 'row-user'   },
  tara:   { label: 'Tara',   className: 'bubble-tara',   rowClass: 'row-agent'  },
  claude: { label: 'Claude', className: 'bubble-claude', rowClass: 'row-agent'  },
  system: { label: '',       className: 'bubble-system', rowClass: 'row-system' },
} as const;

function avatarFor(role: ChatEntry['role']): string | undefined {
  const avatars = window.__taraAvatars;
  if (role === 'user') {
    return avatars?.me;
  }
  // Tara speaks through Claude, so they share the mark rather than one of them
  // appearing without an avatar and breaking the column edge.
  if (role === 'claude' || role === 'tara') {
    return avatars?.claude;
  }
  return undefined;
}

export function ChatBubble({ entry }: ChatBubbleProps) {
  const meta = ROLE_META[entry.role];

  if (entry.role === 'system') {
    return (
      <div className={`chat-row ${meta.rowClass}`}>
        <div className={`chat-bubble ${meta.className}`}>
          <span className="bubble-system-text">{entry.content}</span>
        </div>
      </div>
    );
  }

  const avatar = avatarFor(entry.role);

  return (
    <div className={`chat-row ${meta.rowClass}`}>
      {avatar ? (
        // Decorative: the sender is already named in the bubble header, so alt
        // text here would only be read out twice.
        <img className="chat-avatar" src={avatar} alt="" aria-hidden="true" />
      ) : (
        // Holds the bubble's edge where it would be with an avatar, so a missing
        // image cannot make one message hang out of the column.
        <span className="chat-avatar chat-avatar-empty" aria-hidden="true" />
      )}
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
