import { useState, useEffect } from 'react';
import { postToExtension, onExtensionMessage } from '../vscode-api';

interface SetupStatus {
  geminiKey: boolean;
  claudeInstalled: boolean;
  claudeVersion?: string;
}

interface SetupScreenProps {
  onComplete: () => void;
}

type MicStatus = 'unknown' | 'checking' | 'granted' | 'denied';
type ItemStatus = 'pending' | 'ok' | 'error' | 'checking';

export function SetupScreen({ onComplete }: SetupScreenProps) {
  const [apiKey, setApiKey] = useState('');
  const [apiKeyStatus, setApiKeyStatus] = useState<ItemStatus>('pending');

  const [micStatus, setMicStatus] = useState<MicStatus>('unknown');

  const [claudeStatus, setClaudeStatus] = useState<ItemStatus>('checking');
  const [claudeVersion, setClaudeVersion] = useState('');

  const allDone =
    apiKeyStatus === 'ok' && micStatus === 'granted' && claudeStatus === 'ok';

  // ── Listen for setup status from extension host ───────────────────────────
  useEffect(() => {
    const cleanup = onExtensionMessage((msg) => {
      if (msg.type === 'SETUP_STATUS') {
        const { geminiKey, claudeInstalled, claudeVersion: cv } =
          msg.payload as SetupStatus;
        if (geminiKey) setApiKeyStatus('ok');
        if (claudeInstalled) {
          setClaudeStatus('ok');
          setClaudeVersion(cv ?? '');
        } else {
          setClaudeStatus('error');
        }
      }
    });
    // Request status check on mount
    postToExtension({ type: 'CHECK_SETUP', payload: {} });
    return cleanup;
  }, []);

  // ── Mic permission check ──────────────────────────────────────────────────
  useEffect(() => {
    navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((result) => {
        setMicStatus(result.state === 'granted' ? 'granted' : result.state === 'denied' ? 'denied' : 'unknown');
        result.onchange = () => {
          setMicStatus(result.state === 'granted' ? 'granted' : result.state === 'denied' ? 'denied' : 'unknown');
        };
      })
      .catch(() => setMicStatus('unknown'));
  }, []);

  // ── Save API key ──────────────────────────────────────────────────────────
  function handleSaveKey() {
    if (!apiKey.trim()) return;
    postToExtension({ type: 'SAVE_API_KEY', payload: { key: apiKey.trim() } });
    setApiKeyStatus('ok');
    setApiKey('');
  }

  // ── Request mic ───────────────────────────────────────────────────────────
  async function handleRequestMic() {
    setMicStatus('checking');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setMicStatus('granted');
    } catch {
      setMicStatus('denied');
    }
  }

  return (
    <div className="setup-screen">
      {/* Logo */}
      <div className="setup-logo">
        <div className="setup-logo-dot" />
        <span className="setup-logo-text">TARA</span>
      </div>

      <p className="setup-tagline">Voice AI Coding Assistant</p>
      <p className="setup-sub">Complete setup to start talking to your codebase.</p>

      {/* Step cards */}
      <div className="setup-cards">

        {/* 1 — Gemini API Key */}
        <div className={`setup-card ${apiKeyStatus === 'ok' ? 'card-ok' : ''}`}>
          <div className="setup-card-header">
            <span className="setup-card-icon">🔑</span>
            <div className="setup-card-title-wrap">
              <span className="setup-card-title">Gemini API Key</span>
              <span className="setup-card-desc">Required for voice input &amp; output (STT + TTS)</span>
            </div>
            <StatusBadge status={apiKeyStatus === 'ok' ? 'ok' : 'pending'} />
          </div>
          {apiKeyStatus !== 'ok' && (
            <div className="setup-card-action">
              <input
                id="setup-api-key-input"
                className="setup-input"
                type="password"
                placeholder="AIza..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSaveKey()}
                autoComplete="off"
              />
              <button
                id="setup-save-key-btn"
                className="setup-btn setup-btn-primary"
                onClick={handleSaveKey}
                disabled={!apiKey.trim()}
              >
                Save
              </button>
            </div>
          )}
          {apiKeyStatus === 'ok' && (
            <p className="setup-card-ok-msg">✓ API key configured</p>
          )}
          {apiKeyStatus !== 'ok' && (
            <a
              className="setup-link"
              onClick={() => postToExtension({ type: 'OPEN_URL', payload: { url: 'https://aistudio.google.com/app/apikey' } })}
            >
              Get a free key at aistudio.google.com →
            </a>
          )}
        </div>

        {/* 2 — Microphone */}
        <div className={`setup-card ${micStatus === 'granted' ? 'card-ok' : micStatus === 'denied' ? 'card-error' : ''}`}>
          <div className="setup-card-header">
            <span className="setup-card-icon">🎤</span>
            <div className="setup-card-title-wrap">
              <span className="setup-card-title">Microphone Access</span>
              <span className="setup-card-desc">Required for push-to-talk voice input</span>
            </div>
            <StatusBadge
              status={micStatus === 'granted' ? 'ok' : micStatus === 'denied' ? 'error' : micStatus === 'checking' ? 'checking' : 'pending'}
            />
          </div>
          {micStatus !== 'granted' && micStatus !== 'denied' && (
            <button
              id="setup-mic-btn"
              className="setup-btn setup-btn-primary"
              onClick={handleRequestMic}
              disabled={micStatus === 'checking'}
            >
              {micStatus === 'checking' ? 'Checking…' : 'Grant Microphone Access'}
            </button>
          )}
          {micStatus === 'granted' && (
            <p className="setup-card-ok-msg">✓ Microphone access granted</p>
          )}
          {micStatus === 'denied' && (
            <p className="setup-card-error-msg">
              ✕ Permission denied — allow microphone in your browser/OS settings and reload VS Code
            </p>
          )}
        </div>

        {/* 3 — Claude CLI */}
        <div className={`setup-card ${claudeStatus === 'ok' ? 'card-ok' : claudeStatus === 'error' ? 'card-error' : ''}`}>
          <div className="setup-card-header">
            <span className="setup-card-icon">🤖</span>
            <div className="setup-card-title-wrap">
              <span className="setup-card-title">Claude Code CLI</span>
              <span className="setup-card-desc">Executes AI tasks in your workspace</span>
            </div>
            <StatusBadge status={claudeStatus} />
          </div>
          {claudeStatus === 'ok' && (
            <p className="setup-card-ok-msg">✓ Detected — {claudeVersion}</p>
          )}
          {claudeStatus === 'error' && (
            <div className="setup-card-action setup-card-action-col">
              <p className="setup-card-error-msg">✕ Not found in PATH</p>
              <div className="setup-code-block">
                <code>npm install -g @anthropic-ai/claude-code</code>
                <button
                  id="setup-copy-install-btn"
                  className="setup-copy-btn"
                  onClick={() => navigator.clipboard.writeText('npm install -g @anthropic-ai/claude-code')}
                  title="Copy"
                >
                  ⎘
                </button>
              </div>
              <button
                id="setup-recheck-claude-btn"
                className="setup-btn setup-btn-ghost"
                onClick={() => {
                  setClaudeStatus('checking');
                  postToExtension({ type: 'CHECK_SETUP', payload: {} });
                }}
              >
                Re-check
              </button>
            </div>
          )}
          {claudeStatus === 'checking' && (
            <p className="setup-checking-msg">Detecting claude CLI…</p>
          )}
        </div>
      </div>

      {/* CTA */}
      <button
        id="setup-start-btn"
        className={`setup-start-btn ${allDone ? 'ready' : ''}`}
        disabled={!allDone}
        onClick={onComplete}
      >
        {allDone ? '🎙 Start Talking' : 'Complete setup above'}
      </button>
    </div>
  );
}

function StatusBadge({ status }: { status: ItemStatus | 'pending' }) {
  if (status === 'ok') return <span className="badge badge-ok">✓</span>;
  if (status === 'error') return <span className="badge badge-error">✕</span>;
  if (status === 'checking') return <span className="badge badge-checking">…</span>;
  return <span className="badge badge-pending">○</span>;
}
