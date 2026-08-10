/**
 * Tara microphone capture worklet.
 *
 * Emits raw signed 16-bit little-endian mono PCM at 16 kHz — the format the
 * Gemini Live API expects (`audio/pcm;rate=16000`). MediaRecorder cannot do
 * this: it only produces container formats, and only its first chunk carries the
 * WebM header, so mid-stream chunks are not independently decodable.
 *
 * This file must stay plain, un-bundled JavaScript in `public/` so Vite copies
 * it to `dist/` un-hashed and the extension can hand the webview a stable URI.
 * `audioWorklet.addModule()` is governed by CSP `script-src`, which already
 * allows `${webview.cspSource}` — a nonce cannot authorize it, because the
 * module fetch has no element to carry one.
 *
 * Preferred path: the page creates the AudioContext at 16 kHz, Chromium
 * resamples with its own high-quality resampler, and this processor only has to
 * convert Float32 to Int16. The filter + interpolator below is the fallback for
 * builds where a 16 kHz context throws NotSupportedError.
 */

const TARGET_RATE = 16000;
/** ~100 ms per message at 16 kHz: small enough to stream, large enough to be cheap. */
const FRAMES_PER_MESSAGE = 1600;

/**
 * Transposed-direct-form-II biquad. Two of these in series with the Butterworth
 * Q pair give a 4th-order low-pass, which is what keeps 8–24 kHz content from
 * folding back into the speech band when decimating.
 */
class Biquad {
  constructor(fc, fs, q) {
    const w0 = (2 * Math.PI * fc) / fs;
    const cosw0 = Math.cos(w0);
    const sinw0 = Math.sin(w0);
    const alpha = sinw0 / (2 * q);
    const a0 = 1 + alpha;

    this.b0 = (1 - cosw0) / 2 / a0;
    this.b1 = (1 - cosw0) / a0;
    this.b2 = (1 - cosw0) / 2 / a0;
    this.a1 = (-2 * cosw0) / a0;
    this.a2 = (1 - alpha) / a0;

    this.z1 = 0;
    this.z2 = 0;
  }

  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

class Pcm16kProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || TARGET_RATE;
    this.framesPerMessage = opts.framesPerMessage || FRAMES_PER_MESSAGE;

    // `sampleRate` is a global in AudioWorkletGlobalScope.
    this.ratio = sampleRate / this.targetRate;
    this.needsResample = Math.abs(this.ratio - 1) > 1e-6;

    if (this.needsResample) {
      // Butterworth Q pair for a 4th-order cascade.
      const fc = Math.min(7000, this.targetRate * 0.45);
      this.lp1 = new Biquad(fc, sampleRate, 0.5411961);
      this.lp2 = new Biquad(fc, sampleRate, 1.30656296);
      // Fractional read cursor plus a growable buffer, so the phase carries
      // across render quanta. Resetting per quantum drifts and clicks, because
      // rates like 44100/16000 = 2.75625 are not integer ratios.
      this.filtered = new Float32Array(8192);
      this.filledCount = 0;
      this.readPos = 0;
    }

    this.out = new Int16Array(this.framesPerMessage);
    this.outCount = 0;
    this.stopped = false;

    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'stop') {
        // Flush the partial batch, then tell the page the tail has been sent so
        // it can tear the graph down without truncating the utterance.
        this.flush();
        this.stopped = true;
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }

  /** Float32 [-1,1] to Int16, clamped asymmetrically so full scale cannot wrap. */
  pushSample(sample) {
    let v = sample;
    if (v > 1) {
      v = 1;
    } else if (v < -1) {
      v = -1;
    }
    this.out[this.outCount++] = v < 0 ? v * 0x8000 : v * 0x7fff;
    if (this.outCount >= this.out.length) {
      this.flush();
    }
  }

  flush() {
    if (this.outCount === 0) {
      return;
    }
    // Copy out the filled region and transfer it — zero-copy, and the processor
    // keeps its own buffer for the next batch.
    const slice = this.out.slice(0, this.outCount);
    this.outCount = 0;
    this.port.postMessage({ type: 'pcm', buffer: slice.buffer }, [slice.buffer]);
  }

  appendFiltered(input) {
    const needed = this.filledCount + input.length;
    if (needed > this.filtered.length) {
      let size = this.filtered.length;
      while (size < needed) {
        size *= 2;
      }
      const grown = new Float32Array(size);
      grown.set(this.filtered.subarray(0, this.filledCount));
      this.filtered = grown;
    }
    for (let i = 0; i < input.length; i++) {
      this.filtered[this.filledCount++] = this.lp2.process(this.lp1.process(input[i]));
    }
  }

  resampleAndEmit() {
    // Need one sample past the cursor to interpolate against.
    while (this.readPos + 1 < this.filledCount) {
      const i = Math.floor(this.readPos);
      const t = this.readPos - i;
      this.pushSample(this.filtered[i] * (1 - t) + this.filtered[i + 1] * t);
      this.readPos += this.ratio;
    }
    // The loop exits with readPos up to one full `ratio` past filledCount, so
    // floor(readPos) can exceed it. Clamping matters: an unclamped value makes
    // copyWithin a no-op while filledCount goes negative, after which every
    // appended sample is written out of range and silently lost.
    const consumed = Math.min(Math.floor(this.readPos), this.filledCount);
    if (consumed > 0) {
      this.filtered.copyWithin(0, consumed, this.filledCount);
      this.filledCount -= consumed;
      this.readPos -= consumed; // keep the fractional remainder
    }
  }

  process(inputs) {
    if (this.stopped) {
      return false;
    }

    // `inputs[0]` is an empty array when nothing is connected yet.
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) {
      return true; // keep the node alive; audio may still be arriving
    }

    if (this.needsResample) {
      this.appendFiltered(channel);
      this.resampleAndEmit();
    } else {
      for (let i = 0; i < channel.length; i++) {
        this.pushSample(channel[i]);
      }
    }

    // Must return true — a falsy return lets Chromium collect the node mid-stream.
    return true;
  }
}

registerProcessor('tara-pcm16k', Pcm16kProcessor);
