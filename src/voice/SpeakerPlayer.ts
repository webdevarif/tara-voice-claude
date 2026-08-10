// ─────────────────────────────────────────────────────────────────────────────
// SpeakerPlayer — plays Gemini's audio in the extension host.
//
// Output could stay in the webview (audio *output* needs no permission, and
// `autoplay` is on the webview's Permissions-Policy allow list — which is why
// PcmPlayer still exists as the fallback). The reason it moves here is device
// choice: naming output devices in the webview needs `enumerateDevices()`, and
// Chromium withholds device labels until the origin has been granted a media
// permission — which a VS Code webview never can be. In Node the names are just
// there, the same way they are for capture.
//
// The pvspeaker API was measured before being relied on:
//
//   new PvSpeaker(24000, 16, { bufferSizeSecs, deviceIndex })
//   write(ArrayBuffer) -> number   // 2000 samples in returned 2000, so the
//                                  // return is SAMPLES, not bytes
//   getAvailableDevices() -> string[]   // real names; -1 selects the default
//
// `flush()` is deliberately never called: it blocks the thread until everything
// written has finished playing, and this runs on the extension host's only
// thread — every other extension would stall for the length of the utterance.
// `write()` is the non-blocking half: it takes what fits and reports how much,
// so a full buffer is a reason to come back later rather than to wait.
// ─────────────────────────────────────────────────────────────────────────────

// Deep path on purpose: pvspeaker-node ships declarations under dist/types but
// declares no `types` field in its package.json, so the package root resolves to
// implicit `any`. This is a type-only import, erased at compile time, so it
// creates no runtime dependency on that layout.
import type PvSpeakerInstance from '@picovoice/pvspeaker-node/dist/types/pv_speaker';

/** Gemini Live returns 24 kHz signed 16-bit mono. */
export const OUTPUT_SAMPLE_RATE = 24000;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;

/**
 * Generous, because the cost of a too-small buffer is audible (gaps) while the
 * cost of a large one is a few hundred KB of RAM.
 */
const BUFFER_SIZE_SECS = 5;

/**
 * Audio to bank before the first sample is handed over, in bytes — 250 ms.
 *
 * The device consumes in real time from the moment it starts. Gemini's audio
 * arrives over a socket in bursts that are sometimes slower than real time, so
 * writing the first chunk immediately meant the device caught up with the
 * stream and underran, once per gap. That is exactly the "choppy, and sometimes
 * nothing" symptom. Banking a quarter second first gives the network that slack.
 */
const PREBUFFER_BYTES = OUTPUT_SAMPLE_RATE * BYTES_PER_SAMPLE * 0.25;

/** How long to wait before retrying a write the device buffer could not take. */
const BACKPRESSURE_RETRY_MS = 40;

/** Ids are prefixed so a saved output device can never be read as an input one. */
const PREFIX = 'spk:';

export interface AudioOutputDevice {
  id: string;
  label: string;
  isDefault?: boolean;
}

export interface SpeakerProbe {
  ok: boolean;
  error?: string;
  devices: AudioOutputDevice[];
}

interface PvSpeakerModule {
  PvSpeaker: {
    new (
      sampleRate: number,
      bitsPerSample: number,
      options?: { bufferSizeSecs?: number; deviceIndex?: number }
    ): PvSpeakerInstance;
    getAvailableDevices(): string[];
  };
}

let pvModule: PvSpeakerModule | null | undefined;
let pvError: string | undefined;

/** Guarded, like the recorder's: no prebuilt binary must not break activation. */
function loadPv(): PvSpeakerModule | null {
  if (pvModule !== undefined) {
    return pvModule;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    pvModule = require('@picovoice/pvspeaker-node') as PvSpeakerModule;
    if (typeof pvModule?.PvSpeaker?.getAvailableDevices !== 'function') {
      pvError = 'The bundled audio output module loaded but is missing its API.';
      pvModule = null;
    }
  } catch (err) {
    pvError = err instanceof Error ? err.message : String(err);
    pvModule = null;
  }
  return pvModule;
}

export function outputDeviceSelector(id: string): string {
  return id.startsWith(PREFIX) ? id.slice(PREFIX.length) : '';
}

export function probeSpeakers(): SpeakerProbe {
  const mod = loadPv();
  if (!mod) {
    return { ok: false, error: pvError, devices: [] };
  }
  try {
    const named = mod.PvSpeaker.getAvailableDevices().map((label) => ({
      id: `${PREFIX}${label}`,
      label,
    }));
    if (!named.length) {
      return { ok: false, error: 'No audio output device was reported.', devices: [] };
    }
    return {
      ok: true,
      devices: [
        // As with capture, index 0 is not the system default — index -1 is, and
        // an empty selector maps to it.
        { id: PREFIX, label: 'System default output', isDefault: true },
        ...named,
      ],
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      devices: [],
    };
  }
}

/**
 * A short rising two-tone chime, as playable PCM. Synthesised rather than
 * shipped as an asset, and rather than asked of the model: it costs nothing,
 * needs no round trip, and so can sound the instant the wake word lands.
 */
export function chimePcm(): Buffer {
  const notes = [
    { freq: 660, ms: 90 },
    { freq: 990, ms: 130 },
  ];
  const total = notes.reduce((n, x) => n + Math.round((OUTPUT_SAMPLE_RATE * x.ms) / 1000), 0);
  const buf = Buffer.alloc(total * BYTES_PER_SAMPLE);

  let i = 0;
  for (const note of notes) {
    const samples = Math.round((OUTPUT_SAMPLE_RATE * note.ms) / 1000);
    for (let s = 0; s < samples; s++) {
      // Raised-cosine envelope: a bare sine starting and stopping at full
      // amplitude clicks at both ends, which is worse than no chime at all.
      const envelope = 0.5 - 0.5 * Math.cos((2 * Math.PI * s) / samples);
      const value = Math.sin((2 * Math.PI * note.freq * s) / OUTPUT_SAMPLE_RATE);
      buf.writeInt16LE(Math.round(value * envelope * 5000), i * BYTES_PER_SAMPLE);
      i++;
    }
  }
  return buf;
}

export class SpeakerPlayer {
  private speaker?: PvSpeakerInstance;
  private deviceId = '';
  /** Chunks not yet handed to the device, oldest first. */
  private queue: Buffer[] = [];
  /** Bytes of `queue[0]` already accepted. */
  private headOffset = 0;
  /** Bytes queued but not yet written — drives the prebuffer decision. */
  private pendingBytes = 0;
  /** False until enough audio is banked; see PREBUFFER_BYTES. */
  private primed = false;
  private retryTimer?: NodeJS.Timeout;
  /**
   * Set when the device refuses to open or write. Cleared at the end of a
   * stream, so one bad utterance cannot mute the rest of the session — which is
   * what a permanent latch did.
   */
  private failed = false;

  get available(): boolean {
    return loadPv() !== null;
  }

  /**
   * Selects the output device. Takes effect on the next chunk: reopening mid
   * utterance would cut it off, and the setting is far more likely to change
   * between utterances than during one.
   */
  setDevice(deviceId: string) {
    if (deviceId === this.deviceId) {
      return;
    }
    this.deviceId = deviceId;
    this.close();
    this.failed = false;
  }

  enqueue(pcm: Buffer): void {
    if (pcm.length === 0 || this.failed) {
      return;
    }
    // Opened now even though nothing is written yet: the open costs ~100 ms, and
    // spending it during the prebuffer window is free, whereas spending it after
    // would delay the first word.
    if (!this.open()) {
      return;
    }
    this.queue.push(pcm);
    this.pendingBytes += pcm.length;

    if (!this.primed && this.pendingBytes < PREBUFFER_BYTES) {
      return;
    }
    this.primed = true;
    this.drain();
  }

  /**
   * The stream is complete. Releases whatever is still banked below the
   * prebuffer threshold — without this a reply shorter than 250 ms would sit in
   * the queue and never play — and clears any error so the next one can try.
   */
  endOfStream(): void {
    this.primed = true;
    this.failed = false;
    this.drain();
  }

  /** Plays the wake chime. It is complete in one go, so no prebuffering. */
  playChime(): void {
    this.enqueue(chimePcm());
    this.endOfStream();
  }

  /**
   * Drops anything not yet played — used when the model is interrupted. There is
   * no "clear the buffer" call, but stop() discards it, so this is a stop and a
   * fresh start.
   */
  reset(): void {
    this.queue = [];
    this.headOffset = 0;
    this.pendingBytes = 0;
    this.primed = false;
    this.failed = false;
    this.clearRetry();
    const speaker = this.speaker;
    if (!speaker) {
      return;
    }
    try {
      speaker.stop();
      speaker.start();
    } catch {
      // If it will not restart, drop it; the next enqueue reopens from scratch.
      this.close();
    }
  }

  dispose(): void {
    this.queue = [];
    this.headOffset = 0;
    this.pendingBytes = 0;
    this.primed = false;
    this.clearRetry();
    this.close();
  }

  /**
   * Opens the device, lazily and once. Measured cost: this is the one
   * synchronous stall in the whole path — a 10 ms interval running alongside a
   * 3 s playback saw a worst gap of 125 ms, all of it here, and nothing after.
   * That is why the device is then held for the session rather than reopened per
   * utterance: paying 100 ms before every spoken answer would be worse, and an
   * output device (unlike a microphone) lights no privacy indicator while idle.
   */
  private open(): boolean {
    if (this.speaker) {
      return true;
    }
    const mod = loadPv();
    if (!mod) {
      return false;
    }

    let index = -1;
    const wanted = outputDeviceSelector(this.deviceId);
    if (wanted) {
      try {
        const found = mod.PvSpeaker.getAvailableDevices().indexOf(wanted);
        if (found >= 0) {
          index = found;
        }
      } catch {
        /* fall through to the default device */
      }
    }

    try {
      const speaker = new mod.PvSpeaker(OUTPUT_SAMPLE_RATE, BITS_PER_SAMPLE, {
        bufferSizeSecs: BUFFER_SIZE_SECS,
        deviceIndex: index,
      });
      speaker.start();
      this.speaker = speaker;
      return true;
    } catch (err) {
      // One failure is enough for this stream: retrying per chunk would throw
      // dozens of times a second. endOfStream() clears it.
      this.failed = true;
      pvError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  private drain(): void {
    const speaker = this.speaker;
    if (!speaker) {
      return;
    }
    this.clearRetry();

    while (this.queue.length) {
      const head = this.queue[0];
      const remaining = head.length - this.headOffset;
      // A chunk boundary can land mid-sample; hold the odd byte back and let it
      // join the next chunk rather than shifting every following sample by one.
      const whole = remaining - (remaining % BYTES_PER_SAMPLE);
      if (whole <= 0) {
        if (this.queue.length === 1) {
          return;
        }
        // Stitch the stray byte onto the next chunk.
        const stray = Buffer.from(head.subarray(this.headOffset));
        this.queue.shift();
        this.queue[0] = Buffer.concat([stray, this.queue[0]]);
        this.headOffset = 0;
        continue;
      }

      const slice = head.subarray(this.headOffset, this.headOffset + whole);
      // Copied into its own ArrayBuffer: subarray shares the parent's memory and
      // its byteOffset, and `write` takes a whole ArrayBuffer with no offset.
      const view = new Uint8Array(slice.length);
      view.set(slice);

      let writtenSamples: number;
      try {
        writtenSamples = speaker.write(view.buffer);
      } catch (err) {
        this.failed = true;
        pvError = err instanceof Error ? err.message : String(err);
        this.queue = [];
        this.headOffset = 0;
        this.pendingBytes = 0;
        this.close();
        return;
      }

      // Verified empirically: the return is in samples, not bytes.
      const writtenBytes = writtenSamples * BYTES_PER_SAMPLE;
      this.headOffset += writtenBytes;
      this.pendingBytes = Math.max(0, this.pendingBytes - writtenBytes);

      if (this.headOffset >= head.length) {
        this.queue.shift();
        this.headOffset = 0;
      }

      if (writtenBytes < whole) {
        // Device buffer is full. Come back rather than blocking the host.
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          this.drain();
        }, BACKPRESSURE_RETRY_MS);
        return;
      }
    }
  }

  private clearRetry() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private close() {
    const speaker = this.speaker;
    this.speaker = undefined;
    if (!speaker) {
      return;
    }
    try {
      speaker.stop();
    } catch {
      /* already stopped */
    }
    try {
      speaker.release();
    } catch {
      /* already released */
    }
  }
}
