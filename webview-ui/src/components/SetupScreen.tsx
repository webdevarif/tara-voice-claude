import { useEffect, useState } from 'react';
import { postToExtension, onExtensionMessage } from '../vscode-api';

interface AudioInputDevice {
  id: string;
  label: string;
  isDefault?: boolean;
}

interface SetupStatus {
  geminiKey: boolean;
  claudeInstalled: boolean;
  claudeVersion?: string;
  claudeAuthed?: boolean;
  claudeAuthDetail?: string;
  ffmpegInstalled?: boolean;
  ffmpegVersion?: string;
  ffmpegError?: string;
  ffmpegInstallCommand?: string;
  micDevices?: AudioInputDevice[];
  micDeviceId?: string;
}

interface SetupScreenProps {
  onComplete: () => void;
}

type ItemStatus = 'pending' | 'ok' | 'error' | 'checking';

export function SetupScreen({ onComplete }: SetupScreenProps) {
  const [apiKey, setApiKey] = useState('');
  const [apiKeyStatus, setApiKeyStatus] = useState<ItemStatus>('pending');

  // The microphone check is now "can the extension host reach a capture
  // device", not "will this document be granted getUserMedia" — the latter is
  // permanently no in a VS Code webview, so asking was misleading.
  const [ffmpegStatus, setFfmpegStatus] = useState<ItemStatus>('checking');
  const [ffmpegVersion, setFfmpegVersion] = useState('');
  const [ffmpegError, setFfmpegError] = useState('');
  const [installCommand, setInstallCommand] = useState('');
  const [micDevices, setMicDevices] = useState<AudioInputDevice[]>([]);
  const [selectedMicId, setSelectedMicId] = useState('');

  const [claudeStatus, setClaudeStatus] = useState<ItemStatus>('checking');
  const [claudeVersion, setClaudeVersion] = useState('');
  const [claudeAuthed, setClaudeAuthed] = useState(false);
  const [claudeAuthDetail, setClaudeAuthDetail] = useState('');

  const micReady = ffmpegStatus === 'ok' && micDevices.length > 0;
  const allDone = apiKeyStatus === 'ok' && micReady && claudeStatus === 'ok' && claudeAuthed;

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

      setFfmpegStatus(payload.ffmpegInstalled ? 'ok' : 'error');
      setFfmpegVersion(payload.ffmpegVersion ?? '');
      setFfmpegError(payload.ffmpegError ?? '');
      setInstallCommand(payload.ffmpegInstallCommand ?? '');
      setMicDevices(payload.micDevices ?? []);
      setSelectedMicId(payload.micDeviceId ?? '');
    });
    postToExtension({ type: 'CHECK_SETUP', payload: {} });
    return cleanup;
  }, []);

  function handleSaveKey() {
    if (!apiKey.trim()) {
      return;
    }
    postToExtension({ type: 'SAVE_API_KEY', payload: { key: apiKey.trim() } });
    setApiKey('');
    setApiKeyStatus('checking');
  }

  function handleMicSelect(deviceId: string) {
    setSelectedMicId(deviceId);
    postToExtension({ type: 'SET_MIC_DEVICE', payload: { deviceId } });
  }

  function recheckMic() {
    setFfmpegStatus('checking');
    postToExtension({ type: 'CHECK_SETUP', payload: {} });
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

        {/* 2 — Microphone, captured by ffmpeg in the extension host */}
        <div
          className={`setup-card ${
            micReady ? 'card-ok' : ffmpegStatus === 'error' ? 'card-error' : ''
          }`}
        >
          <div className="setup-card-header">
            <span className="setup-card-icon">🎤</span>
            <div className="setup-card-title-wrap">
              <span className="setup-card-title">Microphone (ffmpeg)</span>
              <span className="setup-card-desc">Required for push-to-talk voice input</span>
            </div>
            <StatusBadge
              status={micReady ? 'ok' : ffmpegStatus === 'checking' ? 'checking' : ffmpegStatus}
            />
          </div>

          {ffmpegStatus === 'checking' && <p className="setup-card-hint">Looking for ffmpeg…</p>}

          {ffmpegStatus === 'error' && (
            <div className="setup-card-action setup-card-action-col">
              <p className="setup-card-error-msg">✕ ffmpeg not found</p>
              <p className="setup-card-hint">
                Tara records through ffmpeg because VS Code does not grant webviews microphone
                access, so the browser API cannot be used here.
              </p>
              {installCommand && (
                <div className="setup-code-block">
                  <code>{installCommand}</code>
                </div>
              )}
              <button
                id="setup-ffmpeg-install-btn"
                className="setup-btn setup-btn-primary"
                onClick={() => postToExtension({ type: 'INSTALL_FFMPEG', payload: {} })}
              >
                Open a terminal with this command
              </button>
              <button
                id="setup-mic-retry-btn"
                className="setup-btn setup-btn-ghost"
                onClick={recheckMic}
              >
                Check again
              </button>
              {ffmpegError && <p className="setup-card-hint">{ffmpegError}</p>}
            </div>
          )}

          {ffmpegStatus === 'ok' && (
            <div className="setup-mic-granted">
              <p className="setup-card-ok-msg">
                ✓ {ffmpegVersion.replace(/^ffmpeg version /i, '').split(' ')[0] || 'ffmpeg ready'}
              </p>
              {micDevices.length > 0 ? (
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
                      <option key={dev.id} value={dev.id}>
                        {dev.label || `Microphone ${i + 1}`}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="setup-card-action setup-card-action-col">
                  <p className="setup-card-error-msg">✕ No capture device found</p>
                  <button
                    id="setup-mic-retry-btn"
                    className="setup-btn setup-btn-ghost"
                    onClick={recheckMic}
                  >
                    Check again
                  </button>
                </div>
              )}
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
