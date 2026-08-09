import React, { useState, useEffect, useRef, useCallback } from 'react';
import { postToExtension, onExtensionMessage } from './vscode-api';
import { VoiceOrb } from './components/VoiceOrb';
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

interface AgentState {
  status: 'idle' | 'running' | 'waiting_for_input' | 'done' | 'error';
  activeAgents: string[];
}

export default function App() {
  const [history, setHistory] = useState<ChatEntry[]>([]);
  const [textInput, setTextInput] = useState('');
  const [agentState, setAgentState] = useState<AgentState>({ status: 'idle', activeAgents: [] });
  const [transcriptDraft, setTranscriptDraft] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [confirmRequest, setConfirmRequest] = useState<{ message: string } | null>(null);
  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const streamingEntryRef = useRef<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // ── Scroll to bottom ─────────────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history, transcriptDraft]);

  // ── Extension message handler ─────────────────────────────────────────────
  useEffect(() => {
    const cleanup = onExtensionMessage((msg) => {
      switch (msg.type) {
        case 'INIT': {
          const { history: h } = msg.payload as { history: ChatEntry[] };
          if (h?.length) setHistory(h);
          break;
        }

        case 'TRANSCRIPT_TOKEN': {
          const { token } = msg.payload as { token: string };
          setTranscriptDraft((d) => d + token);
          break;
        }

        case 'TRANSCRIPT_DONE': {
          const { transcript } = msg.payload as { transcript: string };
          setTranscriptDraft('');
          appendMessage({ role: 'user', content: transcript });
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
          } else if (type === 'tool') {
            appendMessage({ role: 'system', content: text });
          } else if (type === 'error') {
            appendMessage({ role: 'system', content: `✕ ${text}` });
          }
          break;
        }

        case 'AGENT_STATUS': {
          const payload = msg.payload as {
            status?: AgentState['status'];
            activeAgents?: string[];
            action?: string;
          };
          if (payload.action === 'triggerVoice') {
            handleVoiceStart();
          }
          if (payload.status) {
            setAgentState((prev) => ({
              status: payload.status ?? prev.status,
              activeAgents: payload.activeAgents ?? prev.activeAgents,
            }));
          }
          break;
        }

        case 'TTS_AUDIO_CHUNK': {
          const { base64 } = msg.payload as { base64: string };
          playAudioChunk(base64);
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
      }
    });
    return cleanup;
  }, []);

  // ── TTS audio playback ────────────────────────────────────────────────────
  const playAudioChunk = useCallback(async (base64: string) => {
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext({ sampleRate: 24000 });
      }
      const ctx = audioContextRef.current;
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const pcm = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) float32[i] = pcm[i] / 32768;
      const buffer = ctx.createBuffer(1, float32.length, 24000);
      buffer.copyToChannel(float32, 0);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start();
    } catch (e) {
      console.error('[Tara] TTS error', e);
    }
  }, []);

  // ── Chat helpers ──────────────────────────────────────────────────────────
  function appendMessage(partial: Omit<ChatEntry, 'id' | 'timestamp'>) {
    streamingEntryRef.current = null;
    setHistory((h) => [
      ...h,
      { id: `${Date.now()}-${Math.random()}`, timestamp: Date.now(), ...partial },
    ]);
  }

  function appendStreamingMessage(agentId: string, text: string) {
    setHistory((h) => {
      const idx = streamingEntryRef.current
        ? h.findIndex((e) => e.id === streamingEntryRef.current)
        : -1;
      if (idx >= 0) {
        const updated = [...h];
        updated[idx] = { ...updated[idx], content: updated[idx].content + text };
        return updated;
      }
      const entry: ChatEntry = {
        id: `${agentId}-${Date.now()}`,
        role: 'claude',
        content: text,
        timestamp: Date.now(),
        streaming: true,
      };
      streamingEntryRef.current = entry.id;
      return [...h, entry];
    });
  }

  // ── Voice ─────────────────────────────────────────────────────────────────
  async function handleVoiceStart() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Wire up Web Audio analyser for real-time orb animation
      const ctx = new AudioContext();
      audioContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.75;
      source.connect(analyser);
      setAnalyserNode(analyser);

      // MediaRecorder for sending audio to extension host
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = async (e) => {
        if (e.data.size > 0) {
          const buf = await e.data.arrayBuffer();
          const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
          postToExtension({ type: 'VOICE_AUDIO_CHUNK', payload: { base64 } });
        }
      };

      recorder.start(250);
      setIsListening(true);
      postToExtension({ type: 'VOICE_START', payload: {} });
    } catch (err) {
      console.error('[Tara] Mic error:', err);
      appendMessage({ role: 'system', content: '⚠ Microphone access denied.' });
    }
  }

  function handleVoiceEnd() {
    mediaRecorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
    setIsListening(false);
    setAnalyserNode(null);
    postToExtension({ type: 'VOICE_STOP', payload: {} });
  }

  // ── Text submit ───────────────────────────────────────────────────────────
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = textInput.trim();
    if (!text) return;
    setTextInput('');
    appendMessage({ role: 'user', content: text });
    postToExtension({ type: 'SEND_COMMAND', payload: { text } });
  }

  function handleStop() {
    postToExtension({ type: 'STOP_AGENT', payload: {} });
    appendMessage({ role: 'system', content: '⏹ Agent stopped.' });
  }

  return (
    <div className="tara-app">
      {/* Header */}
      <div className="tara-header">
        <div className="tara-logo">
          <span className="tara-logo-dot" />
          <span className="tara-logo-text">Tara</span>
        </div>
        <StatusIndicator status={agentState.status} />
      </div>

      {/* Chat */}
      <div className="tara-chat">
        {history.length === 0 && (
          <div className="tara-empty">
            <span className="tara-empty-label">Voice AI Coding</span>
            <p className="tara-empty-sub">
              Hold the orb to speak. Type below to send a command.
            </p>
          </div>
        )}

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

      {/* Confirm dialog */}
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

      {/* Voice orb — the main interaction element */}
      <VoiceOrb
        isListening={isListening}
        onStart={handleVoiceStart}
        onEnd={handleVoiceEnd}
        analyserNode={analyserNode}
      />

      {/* Text input bar */}
      <div className="tara-input-bar">
        <form className="tara-text-form" onSubmit={handleSubmit}>
          <input
            id="tara-text-input"
            className="tara-text-input"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder="or type a command…"
            disabled={isListening}
            autoComplete="off"
          />
          <button
            id="tara-submit-btn"
            type="submit"
            className="tara-submit-btn"
            disabled={!textInput.trim() || isListening}
            aria-label="Send"
          >
            ↑
          </button>
        </form>

        {agentState.status === 'running' && (
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
