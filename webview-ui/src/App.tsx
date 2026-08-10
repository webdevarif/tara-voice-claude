import React, { useCallback, useEffect, useRef, useState } from 'react';
import { postToExtension, onExtensionMessage } from './vscode-api';
import { PcmPlayer } from './audio';
import { SetupScreen } from './components/SetupScreen';
import { VoiceOrb } from './components/VoiceOrb';
import type { MicState } from './components/VoiceOrb';
import { SessionList } from './components/SessionList';
import type { SessionMeta } from './components/SessionList';
import { ChatBubble } from './components/ChatBubble';
import { StatusIndicator } from './components/StatusIndicator';
import { ConfirmDialog } from './components/ConfirmDialog';
import './App.css';

interface ChatEntry {
  id: string;
  role: 'user' | 'tara' | 'claude' | 'system';
  content: string;
  timestamp: number;
  streaming?: boolean;
}

type AgentStatus = 'idle' | 'running' | 'waiting_for_input' | 'done' | 'error';

interface PendingQuestion {
  agentId: string;
  title: string;
  question: string;
}

export default function App() {
  // `undefined` means "not yet told by the extension", which is different from
  // "setup is incomplete" — rendering the gate before INIT arrives would flash
  // the setup screen at users who finished it long ago.
  const [setupDone, setSetupDone] = useState<boolean | undefined>(undefined);

  const [history, setHistory] = useState<ChatEntry[]>([]);
  const [textInput, setTextInput] = useState('');
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle');
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  const [transcriptDraft, setTranscriptDraft] = useState('');
  /**
   * Owned by the extension host, which is where the microphone actually lives —
   * this only mirrors what it reports, so the orb can never claim to be
   * listening when the device is not open.
   */
  const [micState, setMicState] = useState<MicState>('off');
  const [confirmRequest, setConfirmRequest] = useState<{ message: string } | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [showSessions, setShowSessions] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Keyed by agent id: with up to `tara.maxConcurrentAgents` running, a single
  // slot merged two agents' output into one bubble.
  const streamingByAgentRef = useRef<Map<string, string>>(new Map());
  const playerRef = useRef<PcmPlayer | null>(null);
  // Read inside callbacks that must not be re-created on every state change.
  const micStateRef = useRef<MicState>('off');

  micStateRef.current = micState;
  // Derived where needed; the orb owns the rest of the presentation.

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history, transcriptDraft]);

  // Long-lived playback context. There is no capture context to tear down here
  // — the microphone belongs to the extension host, which releases it itself.
  useEffect(() => {
    playerRef.current = new PcmPlayer();
    return () => {
      void playerRef.current?.close();
      playerRef.current = null;
    };
  }, []);

  // ── Chat helpers ──────────────────────────────────────────────────────────

  const appendMessage = useCallback((partial: Omit<ChatEntry, 'id' | 'timestamp'>) => {
    setHistory((h) => [
      ...h,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        timestamp: Date.now(),
        ...partial,
      },
    ]);
  }, []);

  const appendStreamingMessage = useCallback((agentId: string, text: string) => {
    setHistory((h) => {
      const openId = streamingByAgentRef.current.get(agentId);
      const idx = openId ? h.findIndex((e) => e.id === openId) : -1;
      if (idx >= 0) {
        const updated = [...h];
        updated[idx] = { ...updated[idx], content: updated[idx].content + text };
        return updated;
      }
      const entry: ChatEntry = {
        id: `${agentId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        role: 'claude',
        content: text,
        timestamp: Date.now(),
        streaming: true,
      };
      streamingByAgentRef.current.set(agentId, entry.id);
      return [...h, entry];
    });
  }, []);

  /** Marks open assistant bubbles finished so the next turn starts fresh ones. */
  const closeStreamingMessage = useCallback((agentId?: string) => {
    const map = streamingByAgentRef.current;
    const ids = agentId
      ? [map.get(agentId)].filter((v): v is string => !!v)
      : [...map.values()];
    if (agentId) {
      map.delete(agentId);
    } else {
      map.clear();
    }
    if (!ids.length) {
      return;
    }
    const closing = new Set(ids);
    setHistory((h) => h.map((e) => (closing.has(e.id) ? { ...e, streaming: false } : e)));
  }, []);

  // ── Voice ─────────────────────────────────────────────────────────────────
  //
  // The microphone is opened by the extension host, not here: VS Code builds the
  // webview iframes without `microphone` in their Permissions-Policy allow list,
  // so `getUserMedia` is refused in this document regardless of user or OS
  // consent (microsoft/vscode#250568). Push-to-talk is therefore two messages,
  // and `micState` comes back from the host — 'opening' until the capture device
  // is actually delivering samples, which takes ~450 ms.

  /**
   * One switch, not a hold. The host owns the real state and will correct this
   * on its next VOICE_STATE; setting it here only keeps the click from feeling
   * unresponsive while the device opens.
   */
  const handleToggleMic = useCallback(() => {
    const enabled = micStateRef.current === 'off';
    setMicState(enabled ? 'listening' : 'off');
    postToExtension({ type: 'SET_MIC_ENABLED', payload: { enabled } });
  }, []);

  // ── Extension messages ────────────────────────────────────────────────────

  useEffect(() => {
    const cleanup = onExtensionMessage((msg) => {
      switch (msg.type) {
        case 'INIT': {
          const payload = msg.payload as {
            history?: ChatEntry[];
            sessions?: SessionMeta[];
            activeSessionId?: string;
            setupComplete?: boolean;
            agentStatus?: AgentStatus;
            awaitingInput?: boolean;
          };
          // Always replaced, never merged: INIT is also how a session switch
          // arrives, and switching to an empty one has to clear the view.
          setHistory(payload.history ?? []);
          streamingByAgentRef.current.clear();
          setSessions(payload.sessions ?? []);
          setActiveSessionId(payload.activeSessionId ?? '');
          setSetupDone(!!payload.setupComplete);
          if (payload.agentStatus) {
            setAgentStatus(payload.agentStatus);
          }
          // An agent can already be blocked on a question if the panel was
          // reloaded mid-task. Without this the next message would be sent as a
          // brand-new task instead of the answer it is. The empty agentId makes
          // the extension route it to the longest-waiting agent.
          if (payload.awaitingInput) {
            setPendingQuestion({ agentId: '', title: '', question: '' });
          }
          break;
        }

        case 'TRANSCRIPT_TOKEN': {
          const { token, partial } = msg.payload as { token: string; partial?: boolean };
          // A partial transcript replaces the draft; final tokens accumulate.
          setTranscriptDraft((d) => (partial ? token : d + token));
          break;
        }

        case 'TRANSCRIPT_DONE': {
          setTranscriptDraft('');
          // The extension echoes the user turn into history itself.
          break;
        }

        case 'AGENT_OUTPUT': {
          const { type, text, agentId } = msg.payload as {
            type: string;
            text: string;
            agentId?: string;
          };
          if (type === 'text' || type === 'result') {
            appendStreamingMessage(agentId ?? 'claude', text);
          } else if (type === 'tara') {
            // Tara's own spoken words, arriving complete rather than streamed —
            // the host accumulates the fragments and posts one utterance.
            appendMessage({ role: 'tara', content: text });
          } else if (type === 'tool') {
            appendMessage({ role: 'system', content: `🔧 ${text}` });
          } else if (type === 'error') {
            appendMessage({ role: 'system', content: `✕ ${text}` });
          } else {
            appendMessage({ role: 'system', content: text });
          }
          break;
        }

        case 'AGENT_STATUS': {
          const payload = msg.payload as {
            status?: AgentStatus;
            awaitingInput?: boolean;
            action?: string;
          };
          if (payload.action === 'triggerVoice') {
            handleToggleMic();
          }
          if (payload.status) {
            setAgentStatus(payload.status);
            if (payload.status !== 'running') {
              closeStreamingMessage();
            }
          }
          if (payload.awaitingInput === false) {
            setPendingQuestion(null);
          }
          break;
        }

        case 'AGENT_QUESTION': {
          // The question text already arrived as AGENT_OUTPUT; adding a bubble
          // here would show the same words a second time.
          closeStreamingMessage();
          setPendingQuestion(msg.payload as PendingQuestion);
          break;
        }

        case 'TTS_AUDIO_CHUNK': {
          const { base64 } = msg.payload as { base64: string };
          playerRef.current?.enqueue(base64);
          break;
        }

        case 'TTS_DONE':
          break;

        case 'SESSIONS': {
          const { sessions: list, activeId } = msg.payload as {
            sessions?: SessionMeta[];
            activeId?: string;
          };
          setSessions(list ?? []);
          setActiveSessionId(activeId ?? '');
          break;
        }

        case 'USER_MESSAGE': {
          // The host is the single source of truth for what the user said —
          // typed input used to be drawn locally and dictated input not at all,
          // which is why a spoken command never appeared.
          const { entry } = msg.payload as { entry: ChatEntry };
          if (entry) {
            setHistory((h) => [...h, entry]);
          }
          break;
        }

        case 'VOICE_STATE': {
          // Two independent things arrive on this channel: `state` is the Gemini
          // session, `mic` is the capture device. A frame carries either.
          const { state, mic } = msg.payload as { state?: string; mic?: MicState };
          if (state === 'error' || state === 'idle') {
            setTranscriptDraft('');
          }
          if (mic) {
            setMicState(mic);
          }
          break;
        }

        case 'RISK_CONFIRM_REQUEST': {
          const { message } = msg.payload as { message: string };
          setConfirmRequest({ message });
          break;
        }

        case 'ERROR': {
          const { message } = msg.payload as { message: string };
          appendMessage({ role: 'system', content: `⚠ ${message}` });
          break;
        }

        default:
          break;
      }
    });
    // Requested only now that the handler is registered: a postMessage sent
    // before this script subscribes is dropped, and without INIT the panel
    // would sit blank forever waiting to learn whether setup is done.
    postToExtension({ type: 'WEBVIEW_READY', payload: {} });

    // Last resort, so a lost INIT degrades to the setup screen (which can
    // re-check everything itself) instead of an empty panel.
    const initFallback = setTimeout(() => {
      setSetupDone((current) => (current === undefined ? false : current));
    }, 2500);

    return () => {
      clearTimeout(initFallback);
      cleanup();
    };
  }, [appendMessage, appendStreamingMessage, closeStreamingMessage, handleToggleMic]);

  // ── Text submit ───────────────────────────────────────────────────────────

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = textInput.trim();
    if (!text) {
      return;
    }
    setTextInput('');
    // Not drawn here: the host echoes it back as USER_MESSAGE, which is also the
    // path a dictated command takes. Drawing it locally as well would double it.

    if (pendingQuestion) {
      postToExtension({
        type: 'REPLY_TO_AGENT',
        payload: { text, agentId: pendingQuestion.agentId },
      });
      setPendingQuestion(null);
      return;
    }
    postToExtension({ type: 'SEND_COMMAND', payload: { text } });
  }

  function handleStop() {
    postToExtension({ type: 'STOP_AGENT', payload: {} });
    setPendingQuestion(null);
    appendMessage({ role: 'system', content: '⏹ Stopped.' });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  RENDER
  // ═══════════════════════════════════════════════════════════════════════════

  if (setupDone === undefined) {
    return <div className="tara-app" aria-busy="true" />;
  }

  if (!setupDone) {
    return (
      <SetupScreen
        onComplete={() => {
          postToExtension({ type: 'SETUP_COMPLETE', payload: {} });
          setSetupDone(true);
        }}
      />
    );
  }

  const busy = agentStatus === 'running';
  const canStop = busy || agentStatus === 'waiting_for_input';

  return (
    <div className="tara-app">
      <div className="tara-header">
        <div className="tara-logo">
          <span className="tara-logo-dot" />
          <span className="tara-logo-text">Tara</span>
        </div>
        <div className="tara-header-actions">
          <StatusIndicator status={agentStatus} />
          <button
            id="tara-sessions-btn"
            className={`tara-settings-btn ${showSessions ? 'is-active' : ''}`}
            title="Conversations"
            aria-label="Conversations"
            aria-expanded={showSessions}
            onClick={() => {
              const next = !showSessions;
              setShowSessions(next);
              if (next) {
                // Refreshed on open rather than kept live: another window may
                // have added or renamed one since this panel last heard.
                postToExtension({ type: 'LIST_SESSIONS', payload: {} });
              }
            }}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M2 3h12v1.6H2V3zm0 4.2h12v1.6H2V7.2zM2 11.4h8V13H2v-1.6z" />
            </svg>
          </button>
          <button
            id="tara-settings-btn"
            className="tara-settings-btn"
            title="Open Tara Settings"
            aria-label="Settings"
            onClick={() => postToExtension({ type: 'OPEN_SETTINGS', payload: {} })}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M9.1 0L8 .9l-.4 1.4a5.3 5.3 0 0 0-1.2.7L5 2.6 3.6 3.4l.4 1.4a5.5 5.5 0 0 0-.7 1.2L2 6.4v1.2l1.4.4c.2.4.4.8.7 1.2L3.7 10l.8 1.4 1.4-.4c.4.3.8.5 1.2.7l.4 1.4h1.2l.4-1.4c.4-.2.8-.4 1.2-.7l1.4.4.8-1.4-.4-1.4c.3-.4.5-.8.7-1.2l1.4-.4V6.4l-1.4-.4a5.5 5.5 0 0 0-.7-1.2l.4-1.4L11.4 2l-1.4.4A5.3 5.3 0 0 0 8.8 2L8.4 0H9.1zM8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z" />
            </svg>
          </button>
        </div>
      </div>

      {showSessions && (
        <SessionList
          sessions={sessions}
          activeId={activeSessionId}
          onNew={() => {
            postToExtension({ type: 'NEW_SESSION', payload: {} });
            setShowSessions(false);
          }}
          onOpen={(id) => {
            postToExtension({ type: 'OPEN_SESSION', payload: { id } });
            setShowSessions(false);
          }}
          onRename={(id, title) =>
            postToExtension({ type: 'RENAME_SESSION', payload: { id, title } })
          }
          onDelete={(id) => postToExtension({ type: 'DELETE_SESSION', payload: { id } })}
          onClose={() => setShowSessions(false)}
        />
      )}

      <div className="tara-chat">
        {history.length === 0 && (
          <div className="tara-empty">
            <span className="tara-empty-label">Ready</span>
            <p className="tara-empty-sub">Hold the orb to speak, or type a command below.</p>
          </div>
        )}

        {/* Pushes a short conversation down to the input bar. Only when there is
            something to push: the empty state reads better where it is. */}
        {history.length > 0 && <div className="tara-chat-spacer" />}

        {history.map((entry) => (
          <ChatBubble key={entry.id} entry={entry} />
        ))}

        {transcriptDraft && (
          <div className="tara-transcript-draft">
            <span>🎤</span>
            <span>{transcriptDraft}</span>
            <span className="tara-cursor" />
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {confirmRequest && (
        <ConfirmDialog
          message={confirmRequest.message}
          onConfirm={() => {
            setConfirmRequest(null);
            postToExtension({ type: 'CONFIRM_EXECUTION', payload: {} });
          }}
          onCancel={() => {
            setConfirmRequest(null);
            postToExtension({ type: 'CANCEL_EXECUTION', payload: {} });
          }}
        />
      )}

      <VoiceOrb micState={micState} onToggle={handleToggleMic} />

      <div className="tara-input-bar">
        <form className="tara-text-form" onSubmit={handleSubmit}>
          <input
            id="tara-text-input"
            className="tara-text-input"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder={
              pendingQuestion
                ? 'Answer Tara…'
                : micState === 'hearing'
                  ? 'Listening…'
                  : 'or type a command…'
            }
            // Typing stays available while the mic is on: hands-free listening
            // is not a mode you have to leave to use the keyboard.
            disabled={micState === 'hearing'}
            autoComplete="off"
          />
          <button
            id="tara-submit-btn"
            type="submit"
            className="tara-submit-btn"
            disabled={!textInput.trim() || micState === 'hearing'}
            aria-label={pendingQuestion ? 'Send answer' : 'Send'}
          >
            ↑
          </button>
        </form>

        {canStop && (
          <button
            id="tara-stop-btn"
            className="tara-stop-btn"
            onClick={handleStop}
            title="Stop agent"
            aria-label="Stop agent"
          >
            ⏹
          </button>
        )}
      </div>
    </div>
  );
}
