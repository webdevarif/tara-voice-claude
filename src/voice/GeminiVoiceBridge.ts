import { EventEmitter } from 'events';

// ─────────────────────────────────────────────────────────────────────────────
// GeminiVoiceBridge — raw WebSocket client for the Gemini Live API
//
// Wire protocol (ProtoJSON, camelCase — the server always answers in camelCase):
//
//   client → server, exactly ONE top-level key per frame:
//     { setup: { model, generationConfig, inputAudioTranscription, ... } }
//     { realtimeInput: { audio: { data: <base64>, mimeType: "audio/pcm;rate=16000" } } }
//     { realtimeInput: { audioStreamEnd: true } }
//     { realtimeInput: { text: "..." } }
//
//   server → client, `usageMetadata` plus exactly one of:
//     setupComplete | serverContent | toolCall | toolCallCancellation
//     | goAway | sessionResumptionUpdate
//
// Two constraints shape the design:
//
//  1. `responseModalities` accepts exactly one value. TEXT and AUDIO together is
//     a config error. We therefore run the session in AUDIO and read text from
//     `inputAudioTranscription` / `outputAudioTranscription`, which are separate
//     from modalities and coexist with AUDIO.
//
//  2. The Live API always *answers* a user turn — there is no transcribe-only
//     mode. For push-to-talk we only want the transcript (Claude Code does the
//     actual work), so `mode` gates playback: in 'capture' the model's audio is
//     discarded, and in 'speak' (a turn we started with text) it is forwarded.
// ─────────────────────────────────────────────────────────────────────────────

type WsLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: (code: number, reason: Buffer) => void): void;
};

export type VoiceState =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'listening'
  | 'processing'
  | 'speaking'
  | 'error';

export interface GeminiVoiceOptions {
  apiKey: string;
  model?: string;
  voiceName?: string;
  /** Sample rate of the PCM we send. The capture worklet produces 16 kHz. */
  inputSampleRate?: number;
}

const WS_OPEN = 1;

/** Audio the server returns is always 24 kHz signed 16-bit LE mono. */
export const GEMINI_OUTPUT_SAMPLE_RATE = 24000;

const SYSTEM_INSTRUCTION =
  'You are Tara, a voice front-end for a coding assistant inside VS Code. ' +
  'The user speaks commands about their codebase; another agent carries them out. ' +
  'Never attempt the coding work yourself and never restate the request back. ' +
  'When you are given text to read out, read exactly that text and nothing else. ' +
  'Otherwise reply with at most three words.';

export class GeminiVoiceBridge extends EventEmitter {
  private ws?: WsLike;
  private state: VoiceState = 'idle';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly voiceName: string;
  private readonly inputSampleRate: number;

  /** Frames written before `setupComplete` arrives, replayed in order after. */
  private pending: string[] = [];
  private setupDone = false;
  /** 'capture' discards model audio; 'speak' forwards it. */
  private mode: 'capture' | 'speak' = 'capture';
  /**
   * Whether the user is currently holding push-to-talk. Tracked separately from
   * `state`, because server frames (turnComplete) also drive `state` — gating the
   * mic release on `state === 'listening'` meant a frame arriving mid-utterance
   * could swallow the audioStreamEnd and leave the turn unfinalized.
   */
  private turnActive = false;
  private transcript = '';
  private connectPromise?: Promise<void>;
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private disposed = false;

  private static readonly WS_ENDPOINT =
    'wss://generativelanguage.googleapis.com/ws/' +
    'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

  /**
   * `gemini-2.0-flash-live-001` and `gemini-live-2.5-flash-preview` were both
   * shut down on 2025-12-09; this is their replacement.
   */
  private static readonly DEFAULT_MODEL = 'gemini-3.1-flash-live-preview';

  constructor(opts: GeminiVoiceOptions) {
    super();
    this.apiKey = opts.apiKey;
    this.model = opts.model?.trim() || GeminiVoiceBridge.DEFAULT_MODEL;
    this.voiceName = opts.voiceName?.trim() || 'Aoede';
    this.inputSampleRate = opts.inputSampleRate ?? 16000;
  }

  getState(): VoiceState {
    return this.state;
  }

  private setState(state: VoiceState) {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.emit('state', state);
  }

  // ── Connection ─────────────────────────────────────────────────────────────

  /** Resolves once the server has acknowledged `setup`. Safe to call repeatedly. */
  async connect(): Promise<void> {
    if (this.disposed) {
      throw new Error('Voice bridge has been disposed');
    }
    if (this.setupDone && this.ws?.readyState === WS_OPEN) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.openSocket().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private async openSocket(): Promise<void> {
    this.setState('connecting');
    this.setupDone = false;

    // `ws` only exists in the extension host, so it is imported lazily.
    const { WebSocket } = await import('ws');
    const url = `${GeminiVoiceBridge.WS_ENDPOINT}?key=${encodeURIComponent(this.apiKey)}`;
    const socket = new WebSocket(url) as unknown as WsLike;
    this.ws = socket;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settleOk = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const settleErr = (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      // The API rejects everything sent before setup is acknowledged, so a
      // handshake that never completes has to fail loudly rather than hang.
      const handshakeTimeout = setTimeout(() => {
        settleErr(new Error('Gemini Live did not acknowledge setup within 15s'));
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      }, 15_000);

      socket.on('open', () => {
        socket.send(JSON.stringify(this.buildSetupFrame()));
      });

      socket.on('message', (data: unknown) => {
        const text = toText(data);
        if (!text) {
          return;
        }
        for (const frame of splitFrames(text)) {
          const wasSetupDone = this.setupDone;
          this.handleServerFrame(frame);
          if (!wasSetupDone && this.setupDone) {
            clearTimeout(handshakeTimeout);
            settleOk();
          }
        }
      });

      socket.on('error', (err: Error) => {
        clearTimeout(handshakeTimeout);
        this.setState('error');
        this.emit('error', `Gemini Live connection error: ${err.message}`);
        settleErr(err);
      });

      socket.on('close', (code: number, reason: Buffer) => {
        clearTimeout(handshakeTimeout);
        const wasReady = this.setupDone;
        this.setupDone = false;
        this.ws = undefined;
        this.pending = [];

        if (this.disposed) {
          // Settle so a caller awaiting connect() during dispose is not left hanging.
          settleErr(new Error('Voice bridge was disposed'));
          return;
        }
        if (!wasReady) {
          const detail = reason?.toString?.() || '';
          settleErr(
            new Error(
              `Gemini Live closed before setup (code ${code}${detail ? `: ${detail}` : ''}). ` +
                'Check that the API key is valid and has Live API access.'
            )
          );
          this.setState('error');
          // A reconnect attempt that dies before setup must not end the retry
          // chain — returning here previously made one early failure permanent.
          if (this.reconnectAttempts > 0) {
            this.scheduleReconnect();
          }
          return;
        }

        this.setState('idle');
        this.emit('closed', code);
        // 1000 is a clean close we asked for; anything else is worth retrying,
        // including the 15-minute audio session cap.
        if (code !== 1000) {
          this.scheduleReconnect();
        }
      });
    });
  }

  private buildSetupFrame() {
    return {
      setup: {
        model: `models/${this.model}`,
        generationConfig: {
          // Exactly one modality is allowed. Text comes from the two
          // transcription configs below, which are not modalities.
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: this.voiceName },
            },
          },
        },
        // Siblings of generationConfig, not children of it. Empty object is the
        // entire payload — AudioTranscriptionConfig has no fields.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      },
    };
  }

  private scheduleReconnect() {
    if (this.disposed || this.reconnectTimer) {
      return;
    }
    if (this.reconnectAttempts >= 5) {
      this.emit(
        'error',
        'Lost the Gemini Live connection and could not reconnect. Try again in a moment.'
      );
      return;
    }
    const delay = Math.min(8000, 500 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => {
        /* connect() already surfaced the error */
      });
    }, delay);
  }

  // ── Outbound ───────────────────────────────────────────────────────────────

  private send(frame: unknown) {
    const json = JSON.stringify(frame);
    if (this.setupDone && this.ws?.readyState === WS_OPEN) {
      this.ws.send(json);
      return;
    }
    // Bounded, so a long hold on the mic while disconnected can't grow forever.
    this.pending.push(json);
    if (this.pending.length > 200) {
      this.pending.shift();
    }
  }

  private flushPending() {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      return;
    }
    const queued = this.pending;
    this.pending = [];
    for (const json of queued) {
      this.ws.send(json);
    }
  }

  /**
   * Begin a push-to-talk turn. Model audio is suppressed until `speak()`.
   *
   * Connects first: a session that died since the last utterance (the 15-minute
   * audio cap, a network blip) would otherwise queue the whole turn into
   * `pending` and drop it, with the user seeing nothing but silence.
   */
  async startListening(): Promise<void> {
    this.mode = 'capture';
    this.transcript = '';
    this.turnActive = true;
    this.setState('listening');
    this.emit('listeningStart');
    try {
      await this.connect();
    } catch (err) {
      this.turnActive = false;
      this.emit(
        'error',
        err instanceof Error ? err.message : 'Could not reach Gemini Live.'
      );
    }
  }

  /** Push-to-talk released — ask the server to finalize immediately. */
  stopListening() {
    if (!this.turnActive) {
      return;
    }
    this.turnActive = false;
    this.setState('processing');
    // Hybrid VAD: server-side VAD stays on, but this short-circuits its silence
    // timer so the transcript finalizes as soon as the user lets go.
    this.send({ realtimeInput: { audioStreamEnd: true } });
    this.emit('listeningStop');
  }

  /** base64-encoded signed 16-bit LE mono PCM at `inputSampleRate`. */
  sendAudioChunk(base64Chunk: string) {
    if (!base64Chunk) {
      return;
    }
    this.send({
      realtimeInput: {
        audio: {
          data: base64Chunk,
          mimeType: `audio/pcm;rate=${this.inputSampleRate}`,
        },
      },
    });
  }

  /**
   * Speak `text` aloud. Uses `realtimeInput.text` rather than `clientContent`:
   * on gemini-3.1-flash-live-preview `clientContent` is only for seeding initial
   * history and needs `historyConfig.initialHistoryInClientContent`.
   */
  async speak(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    await this.connect();
    this.mode = 'speak';
    this.setState('speaking');
    this.send({ realtimeInput: { text: trimmed } });
  }

  // ── Inbound ────────────────────────────────────────────────────────────────

  private handleServerFrame(raw: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    if ('setupComplete' in msg) {
      // Documented as having no fields — test for presence, not truthiness.
      this.setupDone = true;
      this.reconnectAttempts = 0;
      this.setState('ready');
      this.flushPending();
      this.emit('ready');
    }

    if (msg.usageMetadata && typeof msg.usageMetadata === 'object') {
      this.emit('usage', msg.usageMetadata);
    }

    if (msg.goAway && typeof msg.goAway === 'object') {
      const timeLeft = (msg.goAway as Record<string, unknown>).timeLeft;
      this.emit('goAway', typeof timeLeft === 'string' ? timeLeft : undefined);
      // The socket is about to close; the close handler reconnects.
    }

    const serverContent = msg.serverContent;
    if (serverContent && typeof serverContent === 'object') {
      this.handleServerContent(serverContent as Record<string, unknown>);
    }
  }

  private handleServerContent(content: Record<string, unknown>) {
    // A single frame can carry audio *and* a transcript on 3.1, so every branch
    // below is an independent `if` — never else-if.

    // Low-latency partial transcript. Present in the shipping SDK types but not
    // in the public reference table, so read it defensively.
    const interim = content.interimInputTranscription;
    if (interim && typeof interim === 'object') {
      const text = (interim as Record<string, unknown>).text;
      if (typeof text === 'string' && text) {
        this.emit('transcriptPartial', text);
      }
    }

    // What the user said — this is the STT result Tara acts on.
    const input = content.inputTranscription;
    if (input && typeof input === 'object') {
      const text = (input as Record<string, unknown>).text;
      if (typeof text === 'string' && text) {
        this.transcript += text;
        this.emit('transcriptToken', text);
      }
      if ((input as Record<string, unknown>).finished === true) {
        this.finalizeTranscript();
      }
    }

    // Transcript of the model's own speech — useful for showing what Tara said.
    const output = content.outputTranscription;
    if (output && typeof output === 'object') {
      const text = (output as Record<string, unknown>).text;
      if (typeof text === 'string' && text) {
        this.emit('spokenText', text);
      }
    }

    const modelTurn = content.modelTurn;
    if (modelTurn && typeof modelTurn === 'object') {
      const parts = (modelTurn as Record<string, unknown>).parts;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (!part || typeof part !== 'object') {
            continue;
          }
          const inlineData = (part as Record<string, unknown>).inlineData as
            | Record<string, unknown>
            | undefined;
          const data = inlineData?.data;
          // In 'capture' mode the model's reply is an unwanted side effect of
          // the API always answering a turn — drop it instead of playing it.
          if (typeof data === 'string' && data && this.mode === 'speak') {
            this.emit('ttsChunk', data);
          }
        }
      }
    }

    if (content.interrupted === true) {
      // Barge-in: whatever was being spoken is abandoned, so leave 'speak' mode
      // rather than letting the next turn's audio be treated as a continuation.
      this.mode = 'capture';
      this.emit('interrupted');
      this.setState('ready');
    }

    if (content.turnComplete === true) {
      this.finalizeTranscript();
      if (this.mode === 'speak') {
        this.emit('ttsDone');
      }
      this.mode = 'capture';
      this.setState('ready');
    }
  }

  private finalizeTranscript() {
    const text = this.transcript.trim();
    this.transcript = '';
    if (text) {
      this.emit('transcriptDone', text);
    }
  }

  // ── Teardown ───────────────────────────────────────────────────────────────

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.pending = [];
    this.setupDone = false;
    this.turnActive = false;
    this.mode = 'capture';
    try {
      this.ws?.close(1000, 'client disconnect');
    } catch {
      /* ignore */
    }
    this.ws = undefined;
    this.setState('idle');
  }

  dispose() {
    this.disposed = true;
    this.disconnect();
    this.removeAllListeners();
  }
}

function toText(data: unknown): string {
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf-8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data as Buffer[]).toString('utf-8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf-8');
  }
  return '';
}

/**
 * Normally one WebSocket message is one JSON object, but be tolerant of a frame
 * that concatenates several — a single bad split would otherwise drop a turn.
 */
function splitFrames(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  // Detect a boundary even when the frames are separated by whitespace or a
  // newline; matching only the literal '}{' dropped those frames entirely.
  if (!/\}\s*\{/.test(trimmed)) {
    return [trimmed];
  }
  const frames: string[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === '{') {
      if (depth === 0) {
        start = i;
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        frames.push(trimmed.slice(start, i + 1));
      }
    }
  }
  return frames.length ? frames : [trimmed];
}
