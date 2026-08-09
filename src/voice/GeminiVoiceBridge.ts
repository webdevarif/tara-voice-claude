import { EventEmitter } from 'events';
import * as https from 'https';
import * as vscode from 'vscode';

// ─────────────────────────────────────────────────────────────────────────────
// GeminiVoiceBridge
//
// Manages the bidirectional connection to Gemini Live API for:
//   1. STT: receives base64 PCM audio chunks from webview → sends to Gemini →
//      streams back transcript tokens
//   2. TTS: receives text → sends to Gemini → streams back audio bytes to
//      webview for playback
//
// Uses the Gemini Live WebSocket API (generativelanguage.googleapis.com)
// ─────────────────────────────────────────────────────────────────────────────

type VoiceSessionState = 'idle' | 'connecting' | 'ready' | 'listening' | 'processing' | 'error';

export class GeminiVoiceBridge extends EventEmitter {
  private ws?: import('ws').WebSocket;
  private state: VoiceSessionState = 'idle';
  private apiKey: string;
  private pendingAudioChunks: string[] = [];
  private reconnectTimer?: NodeJS.Timeout;
  private currentTranscript = '';

  // Gemini Live API endpoint
  private static readonly WS_ENDPOINT =
    'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

  private static readonly MODEL = 'models/gemini-2.0-flash-live-001';

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'error') {
      return;
    }
    this.state = 'connecting';

    try {
      // Dynamically import 'ws' (only available in extension host, not webview)
      const { WebSocket } = await import('ws');
      const url = `${GeminiVoiceBridge.WS_ENDPOINT}?key=${this.apiKey}`;

      this.ws = new WebSocket(url) as unknown as import('ws').WebSocket;

      this.ws.on('open', () => {
        this.sendSetup();
        this.state = 'ready';
        this.emit('ready');

        // Flush any audio queued before connection
        for (const chunk of this.pendingAudioChunks) {
          this.sendAudioChunk(chunk);
        }
        this.pendingAudioChunks = [];
      });

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('error', (err: Error) => {
        console.error('[Tara/GeminiVoice] WebSocket error:', err.message);
        this.state = 'error';
        this.emit('error', err.message);
      });

      this.ws.on('close', () => {
        this.state = 'idle';
        this.emit('disconnected');
      });
    } catch (err) {
      this.state = 'error';
      this.emit('error', `Failed to connect to Gemini Live: ${err}`);
    }
  }

  /** Called when webview sends a VOICE_START event */
  startListening() {
    this.state = 'listening';
    this.currentTranscript = '';
    this.emit('listeningStart');
    this.sendClientEvent({ type: 'start_of_turn' });
  }

  /** Called when webview sends a VOICE_STOP event */
  stopListening() {
    this.state = 'processing';
    this.sendClientEvent({ type: 'end_of_turn' });
    this.emit('listeningStop');
  }

  /** Called with base64-encoded PCM audio chunk from webview */
  receiveAudioChunk(base64Chunk: string) {
    if (this.state === 'ready' || this.state === 'listening') {
      this.sendAudioChunk(base64Chunk);
    } else if (this.state === 'connecting') {
      this.pendingAudioChunks.push(base64Chunk);
    }
  }

  /** Convert text to speech via Gemini TTS and stream audio back */
  async speak(text: string): Promise<void> {
    if (!this.ws || this.state === 'idle') {
      await this.connect();
    }
    this.sendClientEvent({
      type: 'text_input',
      text,
      generateAudio: true,
    });
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.ws?.close();
    this.state = 'idle';
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private sendSetup() {
    const setup = {
      setup: {
        model: GeminiVoiceBridge.MODEL,
        generation_config: {
          response_modalities: ['AUDIO', 'TEXT'],
          speech_config: {
            voice_config: {
              prebuilt_voice_config: { voice_name: 'Aoede' }, // warm female voice
            },
          },
        },
        system_instruction: {
          parts: [
            {
              text:
                'You are Tara, a helpful AI coding assistant living inside VS Code. ' +
                'When given audio input, transcribe it accurately. ' +
                'When asked to speak, use a warm, concise, professional tone. ' +
                'Keep spoken responses brief — the user is focused on coding.',
            },
          ],
        },
      },
    };
    this.wsSend(JSON.stringify(setup));
  }

  private sendAudioChunk(base64Chunk: string) {
    const msg = {
      realtime_input: {
        media_chunks: [
          {
            mime_type: 'audio/pcm',
            data: base64Chunk,
          },
        ],
      },
    };
    this.wsSend(JSON.stringify(msg));
  }

  private sendClientEvent(event: Record<string, unknown>) {
    const msg = { client_content: event };
    this.wsSend(JSON.stringify(msg));
  }

  private wsSend(data: string) {
    if (this.ws?.readyState === 1 /* OPEN */) {
      this.ws.send(data);
    }
  }

  private handleMessage(raw: string) {
    try {
      const msg = JSON.parse(raw);

      // Text transcript from STT
      if (msg.server_content?.parts) {
        for (const part of msg.server_content.parts) {
          if (part.text) {
            this.currentTranscript += part.text;
            this.emit('transcriptToken', part.text);
          }
          if (part.inline_data?.mime_type?.startsWith('audio/')) {
            // TTS audio chunk — base64 encoded
            this.emit('ttsChunk', part.inline_data.data);
          }
        }
      }

      // Turn complete
      if (msg.server_content?.turn_complete) {
        if (this.currentTranscript) {
          this.emit('transcriptDone', this.currentTranscript);
          this.currentTranscript = '';
        }
        this.emit('ttsDone');
        this.state = 'ready';
      }

      // Interrupted
      if (msg.server_content?.interrupted) {
        this.emit('interrupted');
        this.state = 'ready';
      }
    } catch {
      // Non-JSON message, ignore
    }
  }

  dispose() {
    this.disconnect();
    this.removeAllListeners();
  }
}
