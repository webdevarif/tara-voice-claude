// ─────────────────────────────────────────────────────────────────────────────
// Audio plumbing for the Tara webview.
//
// Capture and playback use two separate AudioContexts, and that is not optional:
// an AudioContext has exactly one immutable sampleRate. Capture runs at 16 kHz
// (what Gemini Live wants) and playback at 24 kHz (what it returns). Sharing one
// context would force JS resampling in both directions and break sample-exact
// concatenation of playback chunks.
//
// Lifetimes differ too. The capture context is created and closed per utterance,
// because that is what releases the microphone and because Chromium caps the
// number of concurrent AudioContexts per document. The playback context is
// long-lived so its scheduling cursor and device clock stay valid across turns.
// ─────────────────────────────────────────────────────────────────────────────

const TARGET_INPUT_RATE = 16000;
export const OUTPUT_SAMPLE_RATE = 24000;

/** Scheduling headroom so main-thread jank cannot land a chunk in the past. */
const PLAYBACK_LOOKAHEAD_SEC = 0.08;

declare global {
  interface Window {
    /** Injected by the extension host — the worklet's webview URI. */
    __taraWorkletUri?: string;
  }
  interface Uint8Array {
    toBase64?: () => string;
  }
}

/**
 * `btoa(String.fromCharCode(...bytes))` throws RangeError once the spread
 * exceeds the argument limit, so chunk it. Prefers the native fast path where
 * the embedded Chromium is new enough to have it.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof bytes.toBase64 === 'function') {
    return bytes.toBase64();
  }
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as number[]
    );
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export interface MicCaptureHandlers {
  onChunk: (base64: string) => void;
  onError: (message: string) => void;
}

export interface MicCaptureResult {
  analyser: AnalyserNode;
  /** True when Chromium gave us a native 16 kHz graph and no JS resampling ran. */
  nativeRate: boolean;
}

export class MicCapture {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private node?: AudioWorkletNode;
  private sink?: GainNode;
  private analyser?: AnalyserNode;
  /** Resolves once the worklet confirms it flushed its trailing partial batch. */
  private flushed?: () => void;
  /**
   * Incremented by stop(). start() compares it after each await so a stop that
   * lands mid-startup cannot be followed by start() installing a live
   * microphone that nothing holds a reference to.
   */
  private generation = 0;

  get active(): boolean {
    return !!this.ctx;
  }

  async start(
    deviceId: string | undefined,
    handlers: MicCaptureHandlers
  ): Promise<MicCaptureResult> {
    const generation = ++this.generation;
    const abortIfStale = (cleanup: () => void) => {
      if (this.generation !== generation) {
        cleanup();
        throw new Error('Microphone start was cancelled');
      }
    };
    const workletUri = window.__taraWorkletUri;
    if (!workletUri) {
      throw new Error(
        'Audio worklet URI was not provided by the extension. Rebuild the webview (npm run build).'
      );
    }

    // Chromium honours channelCount but treats an audio sampleRate constraint as
    // negotiable, so the rate is set on the AudioContext instead.
    const constraints: MediaStreamConstraints = {
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    abortIfStale(() => stream.getTracks().forEach((t) => t.stop()));
    this.stream = stream;

    let nativeRate = true;
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: TARGET_INPUT_RATE });
    } catch {
      // Out-of-range rates throw NotSupportedError; the worklet then resamples.
      ctx = new AudioContext();
      nativeRate = false;
    }
    this.ctx = ctx;
    if (ctx.sampleRate !== TARGET_INPUT_RATE) {
      nativeRate = false;
    }

    const abandon = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (ctx.state !== 'closed') {
        void ctx.close();
      }
    };

    // Autoplay policy can start a context suspended.
    if (ctx.state === 'suspended') {
      await ctx.resume();
      abortIfStale(abandon);
    }

    await ctx.audioWorklet.addModule(workletUri);
    abortIfStale(abandon);

    this.source = ctx.createMediaStreamSource(stream);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.75;

    this.node = new AudioWorkletNode(ctx, 'tara-pcm16k', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: { targetRate: TARGET_INPUT_RATE },
    });

    this.node.onprocessorerror = () => {
      handlers.onError('Microphone processing failed — release and try again.');
    };

    this.node.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; buffer?: ArrayBuffer };
      if (data?.type === 'pcm' && data.buffer) {
        handlers.onChunk(bytesToBase64(new Uint8Array(data.buffer)));
      } else if (data?.type === 'flushed') {
        this.flushed?.();
      }
    };

    this.source.connect(this.analyser);
    this.source.connect(this.node);

    // Chromium only pulls nodes reachable from destination, so an unconnected
    // capture node never gets process() called. A zero gain keeps it pulled
    // without monitoring the mic back into the speakers.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.node.connect(this.sink);
    this.sink.connect(ctx.destination);

    return { analyser: this.analyser, nativeRate };
  }

  /** Releases the microphone and the context. Safe to call when not started. */
  async stop(): Promise<void> {
    this.generation++;

    const node = this.node;
    if (node) {
      // Ask the worklet to flush its partial batch and wait for the tail to
      // arrive. Tearing the graph down immediately would drop up to one buffer
      // (~100 ms) off the end of every utterance — usually the last word.
      const tail = new Promise<void>((resolve) => {
        this.flushed = resolve;
        setTimeout(resolve, 150);
      });
      try {
        node.port.postMessage({ type: 'stop' });
        await tail;
      } catch {
        /* port already closed */
      }
      this.flushed = undefined;
      node.port.onmessage = null;
      node.onprocessorerror = null;
    }
    for (const n of [this.source, this.node, this.sink, this.analyser]) {
      try {
        n?.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.stream?.getTracks().forEach((t) => t.stop());

    const ctx = this.ctx;
    this.ctx = undefined;
    this.stream = undefined;
    this.source = undefined;
    this.node = undefined;
    this.sink = undefined;
    this.analyser = undefined;

    if (ctx && ctx.state !== 'closed') {
      // Not closing leaks the context; Chromium caps how many a document may hold.
      try {
        await ctx.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Gapless playback of 24 kHz PCM chunks.
 *
 * `source.start()` with no argument means "now", so a burst of chunks arriving
 * together would all start at the same time and play stacked. A monotonic cursor
 * fixes that; it also has to be clamped forward, because Chromium silently
 * clamps a start time in the past back to now.
 */
export class PcmPlayer {
  private ctx?: AudioContext;
  private nextStartTime = 0;
  private active = new Set<AudioBufferSourceNode>();

  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      // Matching the stream's rate means consecutive chunks concatenate
      // sample-exactly and the device does one high-quality conversion.
      this.ctx = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
      this.nextStartTime = 0;
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  enqueue(base64: string): void {
    const bytes = base64ToBytes(base64);
    if (bytes.length < 2) {
      return;
    }
    const ctx = this.ensureContext();

    // A chunk boundary can land mid-sample; drop the odd trailing byte rather
    // than letting Int16Array throw on a non-even byteLength.
    const usable = bytes.length - (bytes.length % 2);
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, usable / 2);

    const buffer = ctx.createBuffer(1, pcm.length, OUTPUT_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) {
      channel[i] = pcm[i] / 32768;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    if (this.nextStartTime < now + 0.02) {
      this.nextStartTime = now + PLAYBACK_LOOKAHEAD_SEC;
    }
    source.start(this.nextStartTime);
    this.nextStartTime += buffer.duration;

    this.active.add(source);
    source.onended = () => {
      this.active.delete(source);
    };
  }

  /** Stops anything queued — used when the model is interrupted. */
  reset(): void {
    for (const source of this.active) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    this.active.clear();
    this.nextStartTime = this.ctx ? this.ctx.currentTime : 0;
  }

  async close(): Promise<void> {
    this.reset();
    const ctx = this.ctx;
    this.ctx = undefined;
    if (ctx && ctx.state !== 'closed') {
      try {
        await ctx.close();
      } catch {
        /* ignore */
      }
    }
  }
}
