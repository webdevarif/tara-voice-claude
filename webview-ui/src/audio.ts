// ─────────────────────────────────────────────────────────────────────────────
// Audio playback for the Tara webview.
//
// Playback only — capture lives in the extension host (src/voice/MicRecorder.ts)
// because VS Code creates the webview iframes without `microphone` in their
// Permissions-Policy allow list, so `getUserMedia` is refused here no matter
// what the user or the OS allows. Output has no such problem: it needs no
// permission and `autoplay` *is* on the allow list, so this side stays.
// ─────────────────────────────────────────────────────────────────────────────

export const OUTPUT_SAMPLE_RATE = 24000;

/** Scheduling headroom so main-thread jank cannot land a chunk in the past. */
const PLAYBACK_LOOKAHEAD_SEC = 0.08;

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
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
