import { useState, useEffect } from 'react';
import { postToExtension, onExtensionMessage } from '../vscode-api';

interface SetupStatus {
  geminiKey: boolean;
  claudeInstalled: boolean;
  claudeVersion?: string;
  claudeAuthed?: boolean;
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
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState<string>('');

  const [claudeStatus, setClaudeStatus] = useState<ItemStatus>('checking');
  const [claudeVersion, setClaudeVersion] = useState('');
  const [claudeAuthed, setClaudeAuthed] = useState(false);

  const allDone =
    apiKeyStatus === 'ok' && micStatus === 'granted' && claudeStatus === 'ok' && claudeAuthed;

  // ── Listen for setup status from extension host ───────────────────────────
  useEffect(() => {
    const cleanup = onExtensionMessage((msg) => {
      if (msg.type === 'SETUP_STATUS') {
        const { geminiKey, claudeInstalled, claudeVersion: cv, claudeAuthed: ca } =
          msg.payload as SetupStatus;
        if (geminiKey) setApiKeyStatus('ok');
        if (claudeInstalled) {
          setClaudeStatus('ok');
          setClaudeVersion(cv ?? '');
        } else {
          setClaudeStatus('error');
        }
        setClaudeAuthed(!!ca);
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

  // ── Request mic + enumerate devices ────────────────────────────────────
  async function handleRequestMic() {
    setMicStatus('checking');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setMicStatus('granted');
      await enumerateDevices();
    } catch {
      setMicStatus('denied');
    }
  }

  async function enumerateDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId);
      setMicDevices(audioInputs);
      if (audioInputs.length > 0 && !selectedMicId) {
        const defaultDev = audioInputs.find((d) => d.deviceId === 'default') || audioInputs[0];
        setSelectedMicId(defaultDev.deviceId);
        postToExtension({ type: 'SET_MIC_DEVICE', payload: { deviceId: defaultDev.deviceId } });
      }
    } catch {
      // fallback — permission might not be fully granted yet
    }
  }

  function handleMicSelect(deviceId: string) {
    setSelectedMicId(deviceId);
    postToExtension({ type: 'SET_MIC_DEVICE', payload: { deviceId } });
  }

  // Auto-enumerate if permission already granted on mount
  useEffect(() => {
    if (micStatus === 'granted') {
      enumerateDevices();
    }
  }, [micStatus]);

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
            <div className="setup-mic-granted">
              <p className="setup-card-ok-msg">✓ Microphone access granted</p>
              {micDevices.length > 0 && (
                <div className="setup-mic-select-wrap">
                  <label className="setup-mic-select-label" htmlFor="setup-mic-select">Input device</label>
                  <select
                    id="setup-mic-select"
                    className="setup-select"
                    value={selectedMicId}
                    onChange={(e) => handleMicSelect(e.target.value)}
                  >
                    {micDevices.map((dev, i) => (
                      <option key={dev.deviceId} value={dev.deviceId}>
                        {dev.label || `Microphone ${i + 1}`}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}
          {micStatus === 'denied' && (
            <p className="setup-card-error-msg">
              ✕ Permission denied — allow microphone in your browser/OS settings and reload VS Code
            </p>
          )}
        </div>

        {/* 3 — Claude CLI */}
        <div className={`setup-card ${claudeStatus === 'ok' && claudeAuthed ? 'card-ok' : claudeStatus === 'error' ? 'card-error' : (claudeStatus === 'ok' && !claudeAuthed) ? 'card-warn' : ''}`}>
          <div className="setup-card-header">
            <span className="setup-card-icon">🤖</span>
            <div className="setup-card-title-wrap">
              <span className="setup-card-title">Claude Code CLI</span>
              <span className="setup-card-desc">Executes AI tasks in your workspace</span>
            </div>
            <StatusBadge status={claudeStatus === 'ok' && claudeAuthed ? 'ok' : claudeStatus === 'ok' && !claudeAuthed ? 'error' : claudeStatus} />
          </div>

          {/* Installed + Authed */}
          {claudeStatus === 'ok' && claudeAuthed && (
            <p className="setup-card-ok-msg">✓ {claudeVersion} — authenticated</p>
          )}

          {/* Installed but NOT logged in */}
          {claudeStatus === 'ok' && !claudeAuthed && (
            <div className="setup-card-action setup-card-action-col">
              <p className="setup-card-ok-msg">✓ Detected — {claudeVersion}</p>
              <p className="setup-card-warn-msg">⚠ Not logged in — run in terminal:</p>
              <div className="setup-code-block">
                <code>claude auth</code>
                <button
                  id="setup-copy-auth-btn"
                  className="setup-copy-btn"
                  onClick={() => navigator.clipboard.writeText('claude auth')}
                  title="Copy"
                >
                  ⎘
                </button>
              </div>
              <button
                id="setup-recheck-auth-btn"
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

          {/* Not installed */}
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
              <p className="setup-card-hint">Then run <code className="setup-inline-code">claude auth</code> to log in</p>
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
