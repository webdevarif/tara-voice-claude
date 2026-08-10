import { useCallback, useEffect, useState } from 'react';
import { postToExtension, onExtensionMessage } from '../vscode-api';

interface SetupStatus {
  geminiKey: boolean;
  claudeInstalled: boolean;
  claudeVersion?: string;
  claudeAuthed?: boolean;
  claudeAuthDetail?: string;
}

interface SetupScreenProps {
  initialMicDeviceId?: string;
  onMicDeviceChange?: (deviceId: string) => void;
  onComplete: () => void;
}

type MicStatus = 'unknown' | 'checking' | 'granted' | 'denied';
type ItemStatus = 'pending' | 'ok' | 'error' | 'checking';

export function SetupScreen({
  initialMicDeviceId,
  onMicDeviceChange,
  onComplete,
}: SetupScreenProps) {
  const [apiKey, setApiKey] = useState('');
  const [apiKeyStatus, setApiKeyStatus] = useState<ItemStatus>('pending');

  const [micStatus, setMicStatus] = useState<MicStatus>('unknown');
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState(initialMicDeviceId ?? '');
  const [micError, setMicError] = useState('');

  const [claudeStatus, setClaudeStatus] = useState<ItemStatus>('checking');
  const [claudeVersion, setClaudeVersion] = useState('');
  const [claudeAuthed, setClaudeAuthed] = useState(false);
  const [claudeAuthDetail, setClaudeAuthDetail] = useState('');

  const allDone =
    apiKeyStatus === 'ok' && micStatus === 'granted' && claudeStatus === 'ok' && claudeAuthed;

  // ── Setup status from the extension host ──────────────────────────────────
  useEffect(() => {
    const cleanup = onExtensionMessage((msg) => {
      if (msg.type !== 'SETUP_STATUS') {
        return;
      }
      const payload = msg.payload as SetupStatus;
      setApiKeyStatus(payload.geminiKey ? 'ok' : 'pending');
      setClaudeStatus(payload.claudeInstalled ? 'ok' : 'error');
      setClaudeVersion(payload.claudeVersion ?? '');
      setClaudeAuthed(!!payload.claudeAuthed);
      setClaudeAuthDetail(payload.claudeAuthDetail ?? '');
    });
    postToExtension({ type: 'CHECK_SETUP', payload: {} });
    return cleanup;
  }, []);

  // navigator.permissions.query('microphone') is unreliable in a VS Code
  // webview, so the only trustworthy signal is whether getUserMedia resolves.

  function handleSaveKey() {
    if (!apiKey.trim()) {
      return;
    }
    postToExtension({ type: 'SAVE_API_KEY', payload: { key: apiKey.trim() } });
    setApiKey('');
    setApiKeyStatus('checking');
  }

  const enumerateDevices = useCallback(
    async (preferred: string) => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId);
        setMicDevices(inputs);
        if (!inputs.length) {
          return;
        }
        const stillPresent = preferred && inputs.some((d) => d.deviceId === preferred);
        const chosen = stillPresent
          ? preferred
          : (inputs.find((d) => d.deviceId === 'default') ?? inputs[0]).deviceId;
        setSelectedMicId(chosen);
        onMicDeviceChange?.(chosen);
        postToExtension({ type: 'SET_MIC_DEVICE', payload: { deviceId: chosen } });
      } catch {
        // Labels are only exposed after a grant; a failure here is not fatal.
      }
    },
    [onMicDeviceChange]
  );

  async function handleRequestMic() {
    setMicStatus('checking');
    setMicError('');
    try {
      // Only a real getUserMedia call tells us whether capture is allowed.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1 },
      });
      stream.getTracks().forEach((t) => t.stop());
      setMicStatus('granted');
      await enumerateDevices(selectedMicId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMicStatus('denied');
      setMicError(message);
    }
  }

  function handleMicSelect(deviceId: string) {
    setSelectedMicId(deviceId);
    onMicDeviceChange?.(deviceId);
    postToExtension({ type: 'SET_MIC_DEVICE', payload: { deviceId } });
  }

  function recheckClaude() {
    setClaudeStatus('checking');
    postToExtension({ type: 'CHECK_SETUP', payload: {} });
  }

  return (
    <div className="setup-screen">
      <div className="setup-logo">
        <div className="setup-logo-dot" />
        <span className="setup-logo-text">TARA</span>
      </div>

      <p className="setup-tagline">Voice AI Coding Assistant</p>
      <p className="setup-sub">Complete setup to start talking to your codebase.</p>

      <div className="setup-cards">
        {/* 1 — Gemini API key */}
        <div className={`setup-card ${apiKeyStatus === 'ok' ? 'card-ok' : ''}`}>
          <div className="setup-card-header">
            <span className="setup-card-icon">🔑</span>
            <div className="setup-card-title-wrap">
              <span className="setup-card-title">Gemini API Key</span>
              <span className="setup-card-desc">
                Required for voice input &amp; output (STT + TTS)
              </span>
            </div>
            <StatusBadge status={apiKeyStatus} />
          </div>

          {apiKeyStatus === 'ok' ? (
            <p className="setup-card-ok-msg">
              ✓ Stored in VS Code&apos;s encrypted secret storage
            </p>
          ) : (
            <>
              <div className="setup-card-action">
                <input
                  id="setup-api-key-input"
                  className="setup-input"
                  type="password"
                  placeholder="AIza…"
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
              <a
                className="setup-link"
                onClick={() =>
                  postToExtension({
                    type: 'OPEN_URL',
                    payload: { url: 'https://aistudio.google.com/app/apikey' },
                  })
                }
              >
                Get a free key at aistudio.google.com →
              </a>
            </>
          )}
        </div>

        {/* 2 — Microphone */}
        <div
          className={`setup-card ${
            micStatus === 'granted' ? 'card-ok' : micStatus === 'denied' ? 'card-error' : ''
          }`}
        >
          <div className="setup-card-header">
            <span className="setup-card-icon">🎤</span>
            <div className="setup-card-title-wrap">
              <span className="setup-card-title">Microphone Access</span>
              <span className="setup-card-desc">Required for push-to-talk voice input</span>
            </div>
            <StatusBadge
              status={
                micStatus === 'granted'
                  ? 'ok'
                  : micStatus === 'denied'
                    ? 'error'
                    : micStatus === 'checking'
                      ? 'checking'
                      : 'pending'
              }
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
                  <label className="setup-mic-select-label" htmlFor="setup-mic-select">
                    Input device
                  </label>
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
            <div className="setup-card-action setup-card-action-col">
              <p className="setup-card-error-msg">✕ Microphone access was blocked</p>
              {micError && <p className="setup-card-hint">{micError}</p>}
              <button
                id="setup-mic-settings-btn"
                className="setup-btn setup-btn-primary"
                onClick={() => postToExtension({ type: 'OPEN_MIC_SETTINGS', payload: {} })}
              >
                Open Microphone Settings
              </button>
              <button
                id="setup-mic-retry-btn"
                className="setup-btn setup-btn-ghost"
                onClick={() => {
                  setMicError('');
                  setMicStatus('unknown');
                }}
              >
                Try again
              </button>
            </div>
          )}
        </div>

        {/* 3 — Claude Code CLI */}
        <div
          className={`setup-card ${
            claudeStatus === 'ok' && claudeAuthed
              ? 'card-ok'
              : claudeStatus === 'error'
                ? 'card-error'
                : claudeStatus === 'ok' && !claudeAuthed
                  ? 'card-warn'
                  : ''
          }`}
        >
          <div className="setup-card-header">
            <span className="setup-card-icon">🤖</span>
            <div className="setup-card-title-wrap">
              <span className="setup-card-title">Claude Code CLI</span>
              <span className="setup-card-desc">Executes AI tasks in your workspace</span>
            </div>
            <StatusBadge
              status={
                claudeStatus === 'ok' && claudeAuthed
                  ? 'ok'
                  : claudeStatus === 'ok' && !claudeAuthed
                    ? 'error'
                    : claudeStatus
              }
            />
          </div>

          {claudeStatus === 'ok' && claudeAuthed && (
            <p className="setup-card-ok-msg">
              ✓ {claudeVersion}
              {claudeAuthDetail ? ` — ${claudeAuthDetail}` : ' — signed in'}
            </p>
          )}

          {claudeStatus === 'ok' && !claudeAuthed && (
            <div className="setup-card-action setup-card-action-col">
              <p className="setup-card-ok-msg">✓ Detected — {claudeVersion}</p>
              <p className="setup-card-warn-msg">⚠ Not signed in — run in a terminal:</p>
              <div className="setup-code-block">
                <code>claude auth login</code>
                <button
                  id="setup-copy-auth-btn"
                  className="setup-copy-btn"
                  onClick={() => void navigator.clipboard.writeText('claude auth login')}
                  title="Copy"
                >
                  ⎘
                </button>
              </div>
              <button
                id="setup-recheck-auth-btn"
                className="setup-btn setup-btn-ghost"
                onClick={recheckClaude}
              >
                Re-check
              </button>
            </div>
          )}

          {claudeStatus === 'error' && (
            <div className="setup-card-action setup-card-action-col">
              <p className="setup-card-error-msg">✕ Not found on PATH</p>
              <div className="setup-code-block">
                <code>npm install -g @anthropic-ai/claude-code</code>
                <button
                  id="setup-copy-install-btn"
                  className="setup-copy-btn"
                  onClick={() =>
                    void navigator.clipboard.writeText(
                      'npm install -g @anthropic-ai/claude-code'
                    )
                  }
                  title="Copy"
                >
                  ⎘
                </button>
              </div>
              <p className="setup-card-hint">
                Then run <code className="setup-inline-code">claude auth login</code> to sign in.
                If it is installed somewhere unusual, set{' '}
                <code className="setup-inline-code">tara.claudeCodePath</code>.
              </p>
              <button
                id="setup-recheck-claude-btn"
                className="setup-btn setup-btn-ghost"
                onClick={recheckClaude}
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

function StatusBadge({ status }: { status: ItemStatus }) {
  if (status === 'ok') {
    return <span className="badge badge-ok">✓</span>;
  }
  if (status === 'error') {
    return <span className="badge badge-error">✕</span>;
  }
  if (status === 'checking') {
    return <span className="badge badge-checking">…</span>;
  }
  return <span className="badge badge-pending">○</span>;
}
