import { useEffect, useState } from 'react';
import { postToExtension, onExtensionMessage } from '../vscode-api';

interface AudioInputDevice {
  id: string;
  label: string;
  isDefault?: boolean;
  backend?: 'pvrecorder' | 'ffmpeg';
}

interface SetupStatus {
  geminiKey: boolean;
  apiKeyError?: string;
  apiKeyModelWarning?: string;
  claudeInstalled: boolean;
  claudeVersion?: string;
  claudeAuthed?: boolean;
  claudeAuthDetail?: string;
  captureBackend?: 'pvrecorder' | 'ffmpeg';
  bundledCaptureOk?: boolean;
  bundledCaptureError?: string;
  bundledCaptureVersion?: string;
  ffmpegInstalled?: boolean;
  ffmpegVersion?: string;
  ffmpegError?: string;
  ffmpegInstallCommand?: string;
  micDevices?: AudioInputDevice[];
  micDeviceId?: string;
  voiceName?: string;
  voiceOptions?: VoiceOption[];
  liveModel?: string;
  liveModelOptions?: LiveModelOption[];
  speakResponses?: boolean;
}

interface VoiceOption {
  name: string;
  character: string;
}

interface LiveModelOption {
  id: string;
  label: string;
  description?: string;
}

interface SetupScreenProps {
  onComplete: () => void;
}

type ItemStatus = 'pending' | 'ok' | 'error' | 'checking';

export function SetupScreen({ onComplete }: SetupScreenProps) {
  const [apiKey, setApiKey] = useState('');
  const [apiKeyStatus, setApiKeyStatus] = useState<ItemStatus>('pending');
  /** Why the host refused the last key. Empty when there is nothing to explain. */
  const [apiKeyError, setApiKeyError] = useState('');
  const [apiKeyModelWarning, setApiKeyModelWarning] = useState('');

  // The microphone check is now "can the extension host reach a capture
  // device", not "will this document be granted getUserMedia" — the latter is
  // permanently no in a VS Code webview, so asking was misleading.
  const [micCheck, setMicCheck] = useState<ItemStatus>('checking');
  const [backend, setBackend] = useState<'pvrecorder' | 'ffmpeg' | undefined>(undefined);
  const [bundledError, setBundledError] = useState('');
  const [ffmpegError, setFfmpegError] = useState('');
  const [installCommand, setInstallCommand] = useState('');
  const [micDevices, setMicDevices] = useState<AudioInputDevice[]>([]);
  const [selectedMicId, setSelectedMicId] = useState('');

  const [voiceName, setVoiceName] = useState('');
  const [voiceOptions, setVoiceOptions] = useState<VoiceOption[]>([]);
  const [liveModel, setLiveModel] = useState('');
  const [liveModelOptions, setLiveModelOptions] = useState<LiveModelOption[]>([]);
  const [speakResponses, setSpeakResponses] = useState(true);

  const [claudeStatus, setClaudeStatus] = useState<ItemStatus>('checking');
  const [claudeVersion, setClaudeVersion] = useState('');
  const [claudeAuthed, setClaudeAuthed] = useState(false);
  const [claudeAuthDetail, setClaudeAuthDetail] = useState('');

  const micReady = !!backend && micDevices.length > 0;
  const allDone = apiKeyStatus === 'ok' && micReady && claudeStatus === 'ok' && claudeAuthed;

  // ── Setup status from the extension host ──────────────────────────────────
  useEffect(() => {
    const cleanup = onExtensionMessage((msg) => {
      if (msg.type !== 'SETUP_STATUS') {
        return;
      }
      const payload = msg.payload as SetupStatus;
      setApiKeyStatus(
        payload.geminiKey ? 'ok' : payload.apiKeyError ? 'error' : 'pending'
      );
      setApiKeyError(payload.geminiKey ? '' : (payload.apiKeyError ?? ''));
      setApiKeyModelWarning(payload.apiKeyModelWarning ?? '');
      if (payload.geminiKey) {
        // Accepted and stored — now it is safe to drop the plaintext copy.
        setApiKey('');
      }
      setClaudeStatus(payload.claudeInstalled ? 'ok' : 'error');
      setClaudeVersion(payload.claudeVersion ?? '');
      setClaudeAuthed(!!payload.claudeAuthed);
      setClaudeAuthDetail(payload.claudeAuthDetail ?? '');

      setBackend(payload.captureBackend);
      setMicCheck(payload.captureBackend ? 'ok' : 'error');
      setBundledError(payload.bundledCaptureError ?? '');
      setFfmpegError(payload.ffmpegError ?? '');
      setInstallCommand(payload.ffmpegInstallCommand ?? '');
      setMicDevices(payload.micDevices ?? []);
      setSelectedMicId(payload.micDeviceId ?? '');

      setVoiceName(payload.voiceName ?? '');
      setVoiceOptions(payload.voiceOptions ?? []);
      setLiveModel(payload.liveModel ?? '');
      setLiveModelOptions(payload.liveModelOptions ?? []);
      setSpeakResponses(payload.speakResponses !== false);
    });
    postToExtension({ type: 'CHECK_SETUP', payload: {} });
    return cleanup;
  }, []);

  function handleSaveKey() {
    if (!apiKey.trim()) {
      return;
    }
    postToExtension({ type: 'SAVE_API_KEY', payload: { key: apiKey.trim() } });
    // The key stays in the box until the host confirms it — clearing it here
    // would lose a good key to a dropped connection and make the user re-paste
    // it, unable to tell a rejection from a network blip.
    setApiKeyError('');
    setApiKeyStatus('checking');
  }

  function handleMicSelect(deviceId: string) {
    setSelectedMicId(deviceId);
    postToExtension({ type: 'SET_MIC_DEVICE', payload: { deviceId } });
  }

  function recheckMic() {
    setMicCheck('checking');
    postToExtension({ type: 'CHECK_SETUP', payload: {} });
  }

  /**
   * Applied optimistically so the select does not snap back while the host
   * writes the setting; the next SETUP_STATUS is the source of truth.
   */
  function handleVoiceSelect(name: string) {
    setVoiceName(name);
    postToExtension({ type: 'SET_VOICE', payload: { voiceName: name } });
  }

  function handleModelSelect(model: string) {
    setLiveModel(model);
    postToExtension({ type: 'SET_LIVE_MODEL', payload: { model } });
  }

  function handleSpeakToggle(enabled: boolean) {
    setSpeakResponses(enabled);
    postToExtension({ type: 'SET_SPEAK_RESPONSES', payload: { enabled } });
  }

  /**
   * The configured model may not be in the fetched list — a preview id the
   * listing omits, or a listing that failed. Showing it anyway keeps the select
   * from silently displaying someone else's model as if it were the setting.
   */
  const modelChoices =
    liveModel && !liveModelOptions.some((m) => m.id === liveModel)
      ? [{ id: liveModel, label: `${liveModel} (configured)` }, ...liveModelOptions]
      : liveModelOptions;

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
        {/* 1 — Gemini API key. Verified against the API before it is stored. */}
        <div
          className={`setup-card ${
            apiKeyStatus === 'ok' ? 'card-ok' : apiKeyStatus === 'error' ? 'card-error' : ''
          }`}
        >
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
            <>
              <p className="setup-card-ok-msg">
                ✓ Verified with Google, stored in VS Code&apos;s encrypted secret storage
              </p>
              {apiKeyModelWarning && (
                <p className="setup-card-hint">⚠ {apiKeyModelWarning}</p>
              )}
            </>
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
                  onKeyDown={(e) =>
                    e.key === 'Enter' && apiKeyStatus !== 'checking' && handleSaveKey()
                  }
                  autoComplete="off"
                  disabled={apiKeyStatus === 'checking'}
                />
                <button
                  id="setup-save-key-btn"
                  className="setup-btn setup-btn-primary"
                  onClick={handleSaveKey}
                  disabled={!apiKey.trim() || apiKeyStatus === 'checking'}
                >
                  {apiKeyStatus === 'checking' ? 'Verifying…' : 'Verify & Save'}
                </button>
              </div>
              {apiKeyError && <p className="setup-card-error-msg">✕ {apiKeyError}</p>}
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

        {/* 2 — Voice and model. Not part of the gate: both have working defaults. */}
        <div className="setup-card">
          <div className="setup-card-header">
            <span className="setup-card-icon">🗣️</span>
            <div className="setup-card-title-wrap">
              <span className="setup-card-title">Voice &amp; Model</span>
              <span className="setup-card-desc">How Tara sounds and which model listens</span>
            </div>
          </div>

          {apiKeyStatus !== 'ok' ? (
            <p className="setup-card-hint">Add your API key above to load the model list.</p>
          ) : (
            <>
              <div className="setup-mic-select-wrap">
                <label className="setup-mic-select-label" htmlFor="setup-voice-select">
                  Voice
                </label>
                <select
                  id="setup-voice-select"
                  className="setup-select"
                  value={voiceName}
                  onChange={(e) => handleVoiceSelect(e.target.value)}
                >
                  {voiceOptions.map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.name} — {v.character}
                    </option>
                  ))}
                </select>
              </div>

              <div className="setup-mic-select-wrap">
                <label className="setup-mic-select-label" htmlFor="setup-model-select">
                  Live model
                </label>
                <select
                  id="setup-model-select"
                  className="setup-select"
                  value={liveModel}
                  onChange={(e) => handleModelSelect(e.target.value)}
                  disabled={modelChoices.length === 0}
                >
                  {modelChoices.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>

              {liveModelOptions.length === 0 && (
                <p className="setup-card-hint">
                  Could not list models for this key, so only the configured one is shown.
                </p>
              )}

              <label className="setup-toggle" htmlFor="setup-speak-toggle">
                <input
                  id="setup-speak-toggle"
                  type="checkbox"
                  checked={speakResponses}
                  onChange={(e) => handleSpeakToggle(e.target.checked)}
                />
                <span>Read questions and warnings aloud</span>
              </label>

              <p className="setup-card-hint">
                Only models that support a live bidirectional session are listed. Voices come from
                Google&apos;s published set; a few may not be offered on every model.
              </p>
            </>
          )}
        </div>

        {/* 3 — Microphone, captured in the extension host, not this webview */}
        <div
          className={`setup-card ${
            micReady ? 'card-ok' : micCheck === 'error' ? 'card-error' : ''
          }`}
        >
          <div className="setup-card-header">
            <span className="setup-card-icon">🎤</span>
            <div className="setup-card-title-wrap">
              <span className="setup-card-title">Microphone</span>
              <span className="setup-card-desc">Required for push-to-talk voice input</span>
            </div>
            <StatusBadge status={micReady ? 'ok' : micCheck} />
          </div>

          {micCheck === 'checking' && (
            <p className="setup-card-hint">Looking for a capture device…</p>
          )}

          {micReady && (
            <div className="setup-mic-granted">
              <p className="setup-card-ok-msg">
                {backend === 'pvrecorder'
                  ? '✓ Ready — built in, nothing to install'
                  : '✓ Ready — using ffmpeg'}
              </p>
              {backend === 'ffmpeg' && (
                <p className="setup-card-hint">
                  The built-in recorder could not load on this machine, so Tara fell back to
                  ffmpeg. Voice still works; the microphone just takes about half a second longer
                  to open.
                </p>
              )}
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
            </div>
          )}

          {micCheck === 'error' && (
            <div className="setup-card-action setup-card-action-col">
              <p className="setup-card-error-msg">✕ No microphone available</p>
              <p className="setup-card-hint">
                Tara records in the extension host, not in this panel, because VS Code does not
                grant webviews microphone access. The built-in recorder did not load here, and
                ffmpeg — the fallback — was not found either.
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
              {bundledError && <p className="setup-card-hint">Built-in: {bundledError}</p>}
              {ffmpegError && <p className="setup-card-hint">ffmpeg: {ffmpegError}</p>}
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
