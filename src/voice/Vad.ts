// ─────────────────────────────────────────────────────────────────────────────
// Vad — decides, locally and for free, when someone is talking.
//
// Hands-free listening keeps the microphone open the whole time. Streaming all
// of that to the Live API would bill for a roomful of silence, so nothing is
// sent until this says speech started, and the turn is closed when it says
// speech ended. Everything here is arithmetic on the PCM the recorder already
// produces — no model, no network, no cost.
//
// This is not the same thing as the Live API's own VAD: that one runs on
// Google's side and therefore only sees audio we have already paid to send.
//
// Deliberately simple: an energy gate with an adaptive floor. Real VADs classify
// speech vs. noise spectrally; this only separates "louder than the room" from
// "the room". For replacing push-to-talk that is the right trade — the failure
// mode of a spectral model (clipping the first syllable while it decides) is
// worse here than the failure mode of an energy gate (occasionally opening on a
// door slam, which then transcribes to nothing and is discarded).
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'events';

/** 20 ms at 16 kHz, mono, 16-bit. */
const FRAME_SAMPLES = 320;
const FRAME_BYTES = FRAME_SAMPLES * 2;

export interface VadOptions {
  /**
   * How far above the measured room noise a frame must be to count as speech.
   * 3x is loose enough for a quiet talker and tight enough that fan noise, which
   * sits close to the floor, does not trip it.
   */
  thresholdRatio?: number;
  /**
   * Absolute floor, out of 32767. Without it a silent room drives the adaptive
   * floor toward zero and any faint hiss reads as speech.
   */
  minLevel?: number;
  /** Consecutive loud frames before speech is declared. 3 frames = 60 ms. */
  startFrames?: number;
  /**
   * Quiet time before speech is declared over. Long enough to survive the pause
   * between words and inside "um…", short enough not to feel laggy.
   */
  hangoverMs?: number;
}

export class Vad extends EventEmitter {
  private readonly thresholdRatio: number;
  private readonly minLevel: number;
  private readonly startFrames: number;
  private readonly hangoverFrames: number;

  /** Leftover bytes from the previous chunk; chunk sizes are not frame-aligned. */
  private carry: Buffer = Buffer.alloc(0);
  /** Exponential average of quiet frames — the room. */
  private noiseFloor = 0;
  private floorSeeded = false;
  private loudRun = 0;
  private quietRun = 0;
  private speaking = false;

  constructor(options: VadOptions = {}) {
    super();
    this.thresholdRatio = options.thresholdRatio ?? 3;
    this.minLevel = options.minLevel ?? 260;
    this.startFrames = options.startFrames ?? 3;
    this.hangoverFrames = Math.max(1, Math.round((options.hangoverMs ?? 800) / 20));
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Current gate, exposed for tests and for explaining a mis-trigger. */
  get threshold(): number {
    return Math.max(this.noiseFloor * this.thresholdRatio, this.minLevel);
  }

  reset(): void {
    this.carry = Buffer.alloc(0);
    this.noiseFloor = 0;
    this.floorSeeded = false;
    this.loudRun = 0;
    this.quietRun = 0;
    this.speaking = false;
  }

  push(chunk: Buffer): void {
    const data = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const frames = Math.floor(data.length / FRAME_BYTES);
    // Keep the tail; dropping it would lose up to 20 ms per chunk, and at ~30
    // chunks a second that is a real hole in the audio the gate sees.
    this.carry = Buffer.from(data.subarray(frames * FRAME_BYTES));

    for (let f = 0; f < frames; f++) {
      this.handleFrame(rms(data, f * FRAME_BYTES));
    }
  }

  private handleFrame(level: number) {
    if (!this.floorSeeded) {
      this.noiseFloor = level;
      this.floorSeeded = true;
    }

    const loud = level > this.threshold;

    if (!loud) {
      // The floor only tracks quiet frames. Letting speech into the average
      // would raise the gate mid-sentence and cut the speaker off.
      this.noiseFloor = this.noiseFloor * 0.95 + level * 0.05;
    }

    this.emit('level', level, this.threshold);

    if (this.speaking) {
      this.quietRun = loud ? 0 : this.quietRun + 1;
      if (this.quietRun >= this.hangoverFrames) {
        this.speaking = false;
        this.quietRun = 0;
        this.loudRun = 0;
        this.emit('speechEnd');
      }
      return;
    }

    this.loudRun = loud ? this.loudRun + 1 : 0;
    if (this.loudRun >= this.startFrames) {
      this.speaking = true;
      this.loudRun = 0;
      this.quietRun = 0;
      this.emit('speechStart');
    }
  }
}

/** Root-mean-square of one frame, on the raw 0–32767 scale. */
function rms(buf: Buffer, offset: number): number {
  let sum = 0;
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const s = buf.readInt16LE(offset + i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / FRAME_SAMPLES);
}
