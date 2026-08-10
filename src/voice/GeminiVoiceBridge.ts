import { EventEmitter } from 'events';
import { Persona, buildSystemInstruction, languageApiCode } from './GeminiCatalog';

// ─────────────────────────────────────────────────────────────────────────────
// GeminiVoiceBridge — raw WebSocket client for the Gemini Live API
//
// This is a *speech-to-speech* session, not a transcriber bolted to a speech
// synthesiser. Audio goes up, audio comes straight back down, and the coding
// work reaches Claude Code through a function call the model makes mid-turn.
//
// It did not start that way, and why it changed is worth recording, because the
// old shape looked reasonable and was quietly expensive:
//
//   Before: audio → Gemini (used only for `inputTranscription`) → Claude Code
//           → Gemini again (used only to read the answer out) → speaker.
//
//   The Live API has no transcribe-only mode; it always answers a turn. So every
//   command made the model generate a full spoken reply that was then thrown
//   away — billed as audio output and, worse, *waited for*: the transcript was
//   finalized on `turnComplete`, which is the end of that discarded answer. The
//   published reference for BidiGenerateContentTranscription lists a single
//   field, `text`, so the `finished` flag the old code also tested for does not
//   exist and never fired. Dispatch to Claude therefore always paid for a
//   generation nobody heard. Reading the answer back out then cost a second
//   round trip and a second generation.
//
//   Now: audio → Gemini → it speaks, and calls `run_coding_task` when the user
//   is asking for work. Claude's answer returns as a tool response, which the
//   model reads out in the user's own language. One leg instead of three.
//
// Wire protocol (ProtoJSON, camelCase — the server always answers in camelCase):
//
//   client → server, exactly ONE top-level key per frame:
//     { setup: { model, generationConfig, tools, systemInstruction, ... } }
//     { realtimeInput: { audio: { data: <base64>, mimeType: "audio/pcm;rate=16000" } } }
//     { realtimeInput: { audioStreamEnd: true } }
//     { realtimeInput: { text: "..." } }
//     { toolResponse: { functionResponses: [{ id, name, response }] } }
//
//   server → client, `usageMetadata` plus exactly one of:
//     setupComplete | serverContent | toolCall | toolCallCancellation
//     | goAway | sessionResumptionUpdate
//
// One constraint still shapes the setup frame: `responseModalities` accepts
// exactly one value, so TEXT and AUDIO together is a config error. The session
// runs in AUDIO, and the on-screen text comes from `inputAudioTranscription` and
// `outputAudioTranscription`, which are siblings of generationConfig rather than
// modalities and so coexist with AUDIO.
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
  /**
   * Which language Tara understands and speaks: a code from SPOKEN_LANGUAGES, or
   * 'auto'. Applied through the system instruction — see buildSystemInstruction
   * for why it cannot be a config field.
   */
  language?: string;
  /** Who Tara is beyond a voice front-end — see buildSystemInstruction. */
  persona?: Persona;
  /** Sample rate of the PCM we send. The recorder produces 16 kHz. */
  inputSampleRate?: number;
}

/** One in-flight request from the model to run something on our side. */
export interface LiveToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

const WS_OPEN = 1;

/** Audio the server returns is always 24 kHz signed 16-bit LE mono. */
export const GEMINI_OUTPUT_SAMPLE_RATE = 24000;

/** The one tool the model has. Claude Code is what actually touches the repo. */
export const RUN_TASK_TOOL = 'run_coding_task';

/**
 * `NON_BLOCKING` is the whole reason this design works. A coding task runs for
 * anything between seconds and minutes, and a blocking call would freeze the
 * conversation for its duration — the user could not even ask what was
 * happening. Non-blocking lets the model keep talking, and the answer is
 * delivered late with `scheduling: 'INTERRUPT'`, so it is announced on arrival
 * instead of waiting for the user to speak again first.
 */
const TOOL_DECLARATION = {
  functionDeclarations: [
    {
      name: RUN_TASK_TOOL,
      behavior: 'NON_BLOCKING',
      description:
        'Hand a task to Claude Code, a coding agent with read and write access to ' +
        'the files in the open project. Use this for anything involving the real ' +
        'code: reading it, changing it, fixing it, running it, reviewing it, or ' +
        'explaining a specific file or function.',
      parameters: {
        type: 'OBJECT',
        properties: {
          task: {
            type: 'STRING',
            description:
              'The task, in English, as one clear self-contained instruction, ' +
              'including every detail the user gave and nothing they did not.',
          },
        },
        required: ['task'],
      },
    },
  ],
};

export class GeminiVoiceBridge extends EventEmitter {
  private ws?: WsLike;
  private state: VoiceState = 'idle';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly voiceName: string;
  private readonly language: string;
  private readonly persona: Persona;
  private readonly inputSampleRate: number;

  /** Frames written before `setupComplete` arrives, replayed in order after. */
  private pending: string[] = [];
  private setupDone = false;
  /**
   * Bumped on every completed handshake. A tool call belongs to the session that
   * asked for it: after a reconnect its id means nothing to the server, so a
   * caller holding a stale one must be told to fall back to plain speech rather
   * than posting a response that will be discarded in silence.
   */
  private epoch = 0;
  /**
   * Set once a handshake has been refused while a `languageCode` was in the
   * frame. Sticky for the life of the bridge: having learned this model will not
   * take one, there is no reason to spend another failed handshake finding out
   * again on every reconnect.
   */
  private dropLanguageCode = false;
  /**
   * Whether a turn is open and audio is being streamed. Tracked separately from
   * `state`, because server frames also drive `state` — gating the release on
   * `state === 'listening'` meant a frame arriving mid-utterance could swallow
   * the audioStreamEnd and leave the turn unfinalized.
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
   * shut down on 2025-12-09; this is their replacement, and it is a native-audio
   * model, which is what makes the speech-to-speech path above possible.
   */
  private static readonly DEFAULT_MODEL = 'gemini-3.1-flash-live-preview';

  constructor(opts: GeminiVoiceOptions) {
    super();
    this.apiKey = opts.apiKey;
    this.model = opts.model?.trim() || GeminiVoiceBridge.DEFAULT_MODEL;
    this.voiceName = opts.voiceName?.trim() || 'Aoede';
    this.language = opts.language?.trim() || 'auto';
    this.persona = opts.persona ?? 'assistant';
    this.inputSampleRate = opts.inputSampleRate ?? 16000;
  }

  getState(): VoiceState {
    return this.state;
  }

  /** Which session is current. Compare against a value captured earlier. */
  get sessionEpoch(): number {
    return this.epoch;
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
          // Refused while we were naming a language: the language is the first
          // suspect, because everything else in this frame was accepted on the
          // previous connection. Retry once without it, settling the *same*
          // promise, so the caller sees one slower connect rather than an error
          // it could not have acted on. The system instruction still carries the
          // language, so this degrades rather than loses the setting.
          if (!this.disposed && !this.dropLanguageCode && this.usingLanguageCode()) {
            this.dropLanguageCode = true;
            this.emit(
              'languageCodeDropped',
              detail || `setup refused with code ${code}`
            );
            this.openSocket().then(settleOk, settleErr);
            return;
          }
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
        // including the audio session cap.
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
          speechConfig: this.buildSpeechConfig(),
        },
        tools: [TOOL_DECLARATION],
        // Siblings of generationConfig, not children of it. Empty object is the
        // entire payload — AudioTranscriptionConfig has no fields.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: {
          parts: [{ text: buildSystemInstruction(this.language, this.persona) }],
        },
      },
    };
  }

  /**
   * `speechConfig`, with a `languageCode` unless we have learned it is refused.
   *
   * The Live guide says native-audio models "don't support explicitly setting the
   * language code", and on that basis this field was left out. A working
   * implementation against `gemini-3.1-flash-live-preview` sends it and is
   * answered, so the field goes in: a shipped session beats a doc sentence.
   *
   * But not blindly. If setup is refused while we are sending one, `dropLanguageCode`
   * is set and the reconnect goes without it — so a model that really does reject
   * it costs one handshake instead of breaking voice entirely. The system
   * instruction carries the language either way, which is what makes that
   * fallback survivable rather than a silent loss of the setting.
   */
  /** Whether this session names a language in the frame, as opposed to only in the prompt. */
  private usingLanguageCode(): boolean {
    return !!this.language && this.language !== 'auto';
  }

  private buildSpeechConfig(): Record<string, unknown> {
    const config: Record<string, unknown> = {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: this.voiceName },
      },
    };
    // 'auto' is this picker's word for "you decide", not a BCP-47 tag. The API
    // expresses that by the field being absent; forwarded verbatim it would be a
    // code no locale matches, which is a stricter instruction than none.
    if (this.usingLanguageCode() && !this.dropLanguageCode) {
      // The primary subtag only. `bn-BD` is a useful thing to tell the model and
      // not a code the speech table contains — see languageApiCode.
      config.languageCode = languageApiCode(this.language);
    }
    return config;
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
    // Bounded, so a long utterance while disconnected cannot grow forever.
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
   * Open a turn and start streaming audio.
   *
   * Connects first: a session that died since the last utterance (the audio
   * session cap, a network blip) would otherwise queue the whole turn into
   * `pending` and drop it, with the user seeing nothing but silence.
   */
  async startListening(): Promise<void> {
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

  /** Local speech gate closed — ask the server to finalize immediately. */
  stopListening() {
    if (!this.turnActive) {
      return;
    }
    this.turnActive = false;
    this.setState('processing');
    // Hybrid VAD: server-side VAD stays on, but this short-circuits its silence
    // timer so the turn finalizes as soon as the user stops talking.
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
   * Put `text` into the conversation as if the user had said it — for the things
   * that originate on our side rather than at the microphone: a typed command, a
   * warning, a question from an agent.
   *
   * Uses `realtimeInput.text` rather than `clientContent`: on
   * gemini-3.1-flash-live-preview `clientContent` is only for seeding initial
   * history and needs `historyConfig.initialHistoryInClientContent`.
   */
  async speak(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    await this.connect();
    this.setState('speaking');
    this.send({ realtimeInput: { text: trimmed } });
  }

  /**
   * Answer a `toolCall`. `scheduling` decides how the model surfaces it:
   * 'INTERRUPT' to announce it now, 'WHEN_IDLE' to wait for a gap, 'SILENT' to
   * absorb it without speaking.
   *
   * Returns false when the session that made the call is gone — the id would
   * mean nothing to the new one, so the caller should speak the result instead.
   */
  sendToolResponse(
    call: { id: string; name: string; epoch: number },
    result: Record<string, unknown>,
    scheduling: 'INTERRUPT' | 'WHEN_IDLE' | 'SILENT' = 'INTERRUPT'
  ): boolean {
    if (call.epoch !== this.epoch || !this.setupDone) {
      return false;
    }
    this.send({
      toolResponse: {
        functionResponses: [
          {
            id: call.id,
            name: call.name,
            // `scheduling` rides inside `response`, alongside the payload.
            response: { ...result, scheduling },
          },
        ],
      },
    });
    return true;
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
      this.epoch += 1;
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

    const toolCall = msg.toolCall;
    if (toolCall && typeof toolCall === 'object') {
      this.handleToolCall(toolCall as Record<string, unknown>);
    }

    const cancellation = msg.toolCallCancellation;
    if (cancellation && typeof cancellation === 'object') {
      const ids = (cancellation as Record<string, unknown>).ids;
      if (Array.isArray(ids)) {
        this.emit(
          'toolCancel',
          ids.filter((id): id is string => typeof id === 'string')
        );
      }
    }

    const serverContent = msg.serverContent;
    if (serverContent && typeof serverContent === 'object') {
      this.handleServerContent(serverContent as Record<string, unknown>);
    }
  }

  private handleToolCall(toolCall: Record<string, unknown>) {
    const calls = toolCall.functionCalls;
    if (!Array.isArray(calls)) {
      return;
    }
    for (const raw of calls) {
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      const entry = raw as Record<string, unknown>;
      const id = typeof entry.id === 'string' ? entry.id : '';
      const name = typeof entry.name === 'string' ? entry.name : '';
      if (!id || !name) {
        continue;
      }
      const args =
        entry.args && typeof entry.args === 'object'
          ? (entry.args as Record<string, unknown>)
          : {};
      // The epoch travels with the call so a response arriving after a reconnect
      // can be recognised as stale rather than posted into a session that has
      // never heard of it.
      this.emit('toolCall', { id, name, args } satisfies LiveToolCall, this.epoch);
    }
  }

  private handleServerContent(content: Record<string, unknown>) {
    // A single frame can carry audio *and* a transcript, so every branch below is
    // an independent `if` — never else-if.

    // Low-latency partial transcript. Present in the shipping SDK types but not
    // in the public reference table, so read it defensively.
    const interim = content.interimInputTranscription;
    if (interim && typeof interim === 'object') {
      const text = (interim as Record<string, unknown>).text;
      if (typeof text === 'string' && text) {
        this.emit('transcriptPartial', text);
      }
    }

    // What the user said. This is now only for the chat bubble: dispatch to
    // Claude happens on `toolCall`, which arrives while the model is still
    // talking. Waiting for a finalized transcript instead was the old design's
    // entire latency problem.
    const input = content.inputTranscription;
    if (input && typeof input === 'object') {
      const text = (input as Record<string, unknown>).text;
      if (typeof text === 'string' && text) {
        this.transcript += text;
        this.emit('transcriptToken', text);
      }
    }

    // Transcript of the model's own speech — what Tara said, for the transcript
    // pane. Arrives incrementally alongside the audio.
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
          // Every byte of model audio is wanted now. The old code gated this on
          // a `mode` flag that both sides mutated, and the race was audible: a
          // discarded turn's `turnComplete` could arrive after a spoken reply had
          // begun, flip the flag back, and drop that reply's audio on the floor.
          if (typeof data === 'string' && data) {
            this.emit('ttsChunk', data);
          }
        }
      }
    }

    if (content.interrupted === true) {
      // The server has thrown away the rest of its generation. Anything already
      // queued for playback belongs to that abandoned sentence, so the listener
      // is expected to drop it rather than finish speaking a dead reply.
      this.emit('interrupted');
      this.setState('ready');
    }

    if (content.turnComplete === true) {
      this.finalizeTranscript();
      this.emit('ttsDone');
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
