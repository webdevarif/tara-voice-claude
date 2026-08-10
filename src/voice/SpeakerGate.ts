// ─────────────────────────────────────────────────────────────────────────────
// SpeakerGate — answer one person, ignore the room.
//
// Hands-free listening has no idea whose voice it is hearing. In a shared office
// that is not a small flaw: a colleague's sentence becomes a transcript, the
// transcript becomes a tool call, and Claude Code runs against the repository
// because someone nearby was talking. The wake phrase only helps until Tara is
// awake, after which anyone in earshot is in charge.
//
// So the voice itself becomes the credential. This wraps Picovoice Eagle, which
// does text-independent speaker verification locally: enrol once, and every later
// utterance gets a similarity score in [0, 1] against that profile.
//
// Why Eagle rather than something with no extra dependency: the cheap version of
// this — averaged MFCCs and a cosine distance — is genuinely bad at it. It
// confuses two people of similar pitch, and worse, it rejects the enrolled
// speaker when they have a cold or move closer to the microphone. A gate that
// ignores its owner is more infuriating than no gate at all, so an approximate
// one was not worth building. Eagle is purpose-built, runs offline, ships
// prebuilt binaries for every platform this extension targets, and is
// Apache-2.0 — the same shape as the recorder and player modules already here.
//
// The cost, stated plainly because it is the one real drawback: Eagle needs a
// free AccessKey from console.picovoice.ai. Nothing else here does. Without one
// the gate reports itself unavailable and Tara behaves exactly as before —
// listening to everyone — rather than refusing to listen at all.
//
// Two sizes are read from the engine rather than hardcoded, because they are
// properties of the shipped model and a wrong guess would fail at the worst
// moment: `EagleProfiler.frameLength` for enrolment chunks, and
// `Eagle.minProcessSamples` for the smallest window that can be scored. (The
// published docstring points at a `.minEnrollSamples` the shipped class does not
// expose; `frameLength` is what the implementation actually reads, from
// `profiler_frame_length()`.)
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Eagle operates on 16 kHz mono 16-bit PCM — the same as MicRecorder produces. */
export const GATE_SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

/** Format version for the on-disk profile, so a future engine change is detectable. */
const PROFILE_VERSION = 1;

interface EagleProfilerInstance {
  readonly frameLength: number;
  readonly sampleRate: number;
  readonly version: string;
  enroll(pcm: Int16Array): number;
  flush(): number;
  export(): Uint8Array;
  reset(): void;
  release(): void;
}

interface EagleInstance {
  readonly minProcessSamples: number;
  readonly sampleRate: number;
  readonly version: string;
  process(pcm: Int16Array, profiles: Uint8Array[] | Uint8Array): number[] | null;
  release(): void;
}

interface EagleModule {
  EagleProfiler: new (
    accessKey: string,
    options?: Record<string, unknown>
  ) => EagleProfilerInstance;
  Eagle: new (accessKey: string, options?: Record<string, unknown>) => EagleInstance;
}

let eagleModule: EagleModule | null | undefined;
let loadError: string | undefined;

/** Guarded like the recorder's: a missing prebuilt binary must not break activation. */
function loadEagle(): EagleModule | null {
  if (eagleModule !== undefined) {
    return eagleModule;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@picovoice/eagle-node') as EagleModule;
    if (typeof mod?.Eagle !== 'function' || typeof mod?.EagleProfiler !== 'function') {
      loadError = 'The bundled speaker-recognition module loaded but is missing its API.';
      eagleModule = null;
    } else {
      eagleModule = mod;
    }
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    eagleModule = null;
  }
  return eagleModule;
}

export interface SpeakerGateProbe {
  /** The native module is present and loadable. */
  moduleOk: boolean;
  moduleError?: string;
  /** A profile has been enrolled and is on disk. */
  hasProfile: boolean;
  enrolledAt?: number;
  enrolledSeconds?: number;
}

export function speakerDir(): string {
  return path.join(os.homedir(), '.tara', 'speaker');
}

interface ProfileMeta {
  version: number;
  enrolledAt: number;
  seconds: number;
  engineVersion?: string;
}

function profilePaths() {
  const dir = speakerDir();
  return {
    dir,
    profile: path.join(dir, 'profile.bin'),
    meta: path.join(dir, 'meta.json'),
  };
}

export function probeSpeakerGate(): SpeakerGateProbe {
  const mod = loadEagle();
  const probe: SpeakerGateProbe = {
    moduleOk: !!mod,
    moduleError: mod ? undefined : loadError,
    hasProfile: false,
  };
  const { profile, meta } = profilePaths();
  try {
    if (fs.statSync(profile).size > 0) {
      probe.hasProfile = true;
      const parsed = JSON.parse(fs.readFileSync(meta, 'utf8')) as ProfileMeta;
      probe.enrolledAt = parsed.enrolledAt;
      probe.enrolledSeconds = parsed.seconds;
    }
  } catch {
    // No profile, or unreadable metadata. `hasProfile` keeps whatever was set:
    // a profile whose metadata is missing is still a usable profile.
  }
  return probe;
}

/**
 * One enrolment run.
 *
 * Eagle reports how far along it is rather than taking a fixed amount of audio,
 * so the caller feeds speech until `percentage` reaches 100 and the UI shows real
 * progress instead of a guessed countdown. It also means a short voice memo is
 * allowed to be *not enough*, and can say so, rather than producing a weak
 * profile that quietly fails later.
 */
export class SpeakerEnrollment {
  private profiler?: EagleProfilerInstance;
  /** Samples not yet handed over; `enroll` is fed whole frames. */
  private carry = Buffer.alloc(0);
  private samplesFed = 0;
  private percent = 0;

  constructor(accessKey: string) {
    const mod = loadEagle();
    if (!mod) {
      throw new Error(loadError ?? 'Speaker recognition is not available on this platform.');
    }
    this.profiler = new mod.EagleProfiler(accessKey.trim());
  }

  get percentage(): number {
    return this.percent;
  }

  /** Seconds of audio consumed, for telling the user how much they have given. */
  get seconds(): number {
    return this.samplesFed / GATE_SAMPLE_RATE;
  }

  get engineVersion(): string {
    return this.profiler?.version ?? '';
  }

  /**
   * Adds audio. Returns the enrolment percentage after this batch.
   *
   * Fed in whole frames with the remainder carried: chunk boundaries from the
   * recorder have nothing to do with the model's frame length, and dropping the
   * remainder would lose a slice of speech on every single chunk.
   */
  push(pcm: Buffer): number {
    const profiler = this.profiler;
    if (!profiler) {
      throw new Error('This enrolment has already finished.');
    }
    const data = this.carry.length ? Buffer.concat([this.carry, pcm]) : pcm;
    const frameBytes = profiler.frameLength * BYTES_PER_SAMPLE;
    const frames = Math.floor(data.length / frameBytes);
    this.carry = Buffer.from(data.subarray(frames * frameBytes));

    for (let f = 0; f < frames; f++) {
      const start = f * frameBytes;
      const view = new Int16Array(profiler.frameLength);
      for (let i = 0; i < profiler.frameLength; i++) {
        view[i] = data.readInt16LE(start + i * BYTES_PER_SAMPLE);
      }
      this.percent = profiler.enroll(view);
      this.samplesFed += profiler.frameLength;
    }
    return this.percent;
  }

  /**
   * Ends the run and returns the profile, or null when there was not enough
   * speech for Eagle to reach 100%.
   *
   * Null rather than an exception, and rather than exporting anyway: `export()`
   * refuses an unfinished profile, and forcing one out would be worse — a
   * half-trained profile is exactly what starts rejecting its owner.
   */
  finish(): { profile: Uint8Array; seconds: number; engineVersion: string } | null {
    const profiler = this.profiler;
    if (!profiler) {
      return null;
    }
    try {
      this.percent = profiler.flush();
      if (this.percent < 100) {
        return null;
      }
      return {
        profile: profiler.export(),
        seconds: this.seconds,
        engineVersion: profiler.version,
      };
    } finally {
      this.release();
    }
  }

  release() {
    const profiler = this.profiler;
    this.profiler = undefined;
    this.carry = Buffer.alloc(0);
    try {
      profiler?.release();
    } catch {
      /* already released */
    }
  }
}

export class SpeakerGate {
  private eagle?: EagleInstance;
  private profile?: Uint8Array;
  /** Set when the engine refused to start, so it is not retried per chunk. */
  private failed = false;
  private lastError = '';

  get available(): boolean {
    return loadEagle() !== null;
  }

  get moduleError(): string | undefined {
    return this.available ? undefined : loadError;
  }

  get error(): string {
    return this.lastError;
  }

  /** True once a profile is loaded and the engine is ready to score. */
  get armed(): boolean {
    return !!this.eagle && !!this.profile;
  }

  /** Smallest window that can be scored, in bytes. Zero until the engine is open. */
  get minVerifyBytes(): number {
    return this.eagle ? this.eagle.minProcessSamples * BYTES_PER_SAMPLE : 0;
  }

  hasProfile(): boolean {
    return probeSpeakerGate().hasProfile;
  }

  /**
   * Opens the engine against the stored profile. Returns false when there is no
   * profile, no key, or no module — all of which mean "gate off", not "error".
   */
  arm(accessKey: string): boolean {
    if (this.armed) {
      return true;
    }
    if (this.failed) {
      return false;
    }
    const mod = loadEagle();
    const key = accessKey.trim();
    if (!mod || !key) {
      return false;
    }
    const stored = this.readProfile();
    if (!stored) {
      return false;
    }
    try {
      this.eagle = new mod.Eagle(key);
      this.profile = stored;
      this.lastError = '';
      return true;
    } catch (err) {
      // One failure is enough: retrying per chunk would throw many times a
      // second. Cleared by disarm(), which a new key or profile goes through.
      this.failed = true;
      this.lastError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  /** Closes the engine. The next arm() re-reads the profile and clears any error. */
  disarm() {
    const eagle = this.eagle;
    this.eagle = undefined;
    this.profile = undefined;
    this.failed = false;
    try {
      eagle?.release();
    } catch {
      /* already released */
    }
  }

  /**
   * Scores `pcm` against the enrolled profile.
   *
   * Returns null when the gate is off, or when Eagle found too little voice in
   * the window to judge — which means "keep listening", not "rejected". Callers
   * must not read null as a failed match, or the gate would refuse every quiet
   * first syllable.
   */
  verify(pcm: Buffer): number | null {
    const eagle = this.eagle;
    const profile = this.profile;
    if (!eagle || !profile) {
      return null;
    }
    const samples = Math.floor(pcm.length / BYTES_PER_SAMPLE);
    if (samples < eagle.minProcessSamples) {
      return null;
    }
    const view = new Int16Array(samples);
    for (let i = 0; i < samples; i++) {
      view[i] = pcm.readInt16LE(i * BYTES_PER_SAMPLE);
    }
    try {
      const scores = eagle.process(view, [profile]);
      // Documented as possibly null despite the declared return type.
      if (!scores || scores.length === 0) {
        return null;
      }
      return scores[0];
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  // ── Profile storage ────────────────────────────────────────────────────────
  //
  // Beside the conversations, under ~/.tara, for the same reason: enrolling a
  // voice costs the user a minute of reading aloud, and VS Code's extension
  // storage is erased on uninstall. Re-enrolling after every reinstall would make
  // the feature feel disposable.

  saveProfile(profile: Uint8Array, seconds: number, engineVersion?: string) {
    const { dir, profile: profilePath, meta } = profilePaths();
    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(profilePath, Buffer.from(profile));
    const record: ProfileMeta = {
      version: PROFILE_VERSION,
      enrolledAt: Date.now(),
      seconds: Math.round(seconds * 10) / 10,
      engineVersion,
    };
    writeAtomic(meta, Buffer.from(JSON.stringify(record, null, 2), 'utf8'));
    // Any open engine is still holding the previous profile.
    this.disarm();
  }

  deleteProfile() {
    const { profile, meta } = profilePaths();
    this.disarm();
    for (const target of [profile, meta]) {
      try {
        fs.rmSync(target, { force: true });
      } catch {
        /* nothing to remove */
      }
    }
  }

  private readProfile(): Uint8Array | undefined {
    try {
      const buf = fs.readFileSync(profilePaths().profile);
      return buf.length ? new Uint8Array(buf) : undefined;
    } catch {
      return undefined;
    }
  }

  dispose() {
    this.disarm();
  }
}

/** Temp file then rename, so a crash mid-write cannot leave a truncated profile. */
function writeAtomic(target: string, data: Buffer) {
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading a voice file
//
// A voice memo arrives as whatever the phone or recorder produced. WAV is parsed
// here because it is the one format that needs no external tool and is what every
// desktop recorder can export; everything else goes through ffmpeg, which this
// extension already knows how to locate for its fallback recorder.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decodes an audio file to 16 kHz mono signed 16-bit PCM.
 *
 * The built-in WAV reader is tried first even where ffmpeg exists: it is instant,
 * it cannot fail for want of an external binary, and re-encoding audio that is
 * already correct gains nothing.
 */
export async function decodeToPcm16k(
  filePath: string,
  ffmpegPath: string
): Promise<{ pcm: Buffer; via: 'wav' | 'ffmpeg' }> {
  const raw = await fs.promises.readFile(filePath);
  const wav = decodeWav(raw);
  if (wav) {
    return { pcm: wav, via: 'wav' };
  }
  return { pcm: await decodeViaFfmpeg(filePath, ffmpegPath), via: 'ffmpeg' };
}

/**
 * Minimal RIFF/WAVE reader: 16-bit PCM only, any channel count, any rate.
 *
 * Returns undefined rather than throwing for anything it does not handle —
 * float32, 24-bit, ADPCM, or a file that is not WAV at all — so the caller falls
 * through to ffmpeg instead of failing.
 *
 * Chunks are walked rather than assumed to sit at fixed offsets: files written by
 * phones and editors routinely carry `LIST` or `fact` chunks between `fmt ` and
 * `data`, and reading `data` from a fixed offset then treats metadata as audio.
 */
function decodeWav(buf: Buffer): Buffer | undefined {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    return undefined;
  }
  if (buf.toString('ascii', 8, 12) !== 'WAVE') {
    return undefined;
  }

  let channels = 0;
  let rate = 0;
  let bits = 0;
  let format = 0;
  let data: Buffer | undefined;

  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }
    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = body + size + (size % 2);
  }

  // 1 is PCM; 0xFFFE is WAVE_FORMAT_EXTENSIBLE, still PCM when the width is 16.
  if (!data || !channels || !rate || bits !== 16 || (format !== 1 && format !== 0xfffe)) {
    return undefined;
  }
  return resample(toMono(data, channels), rate);
}

/** Averages channels to one. Averaging, not picking: a voice panned to one side would be lost. */
function toMono(data: Buffer, channels: number): Buffer {
  if (channels === 1) {
    return data;
  }
  const frames = Math.floor(data.length / (channels * BYTES_PER_SAMPLE));
  const out = Buffer.alloc(frames * BYTES_PER_SAMPLE);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += data.readInt16LE((f * channels + c) * BYTES_PER_SAMPLE);
    }
    out.writeInt16LE(Math.round(sum / channels), f * BYTES_PER_SAMPLE);
  }
  return out;
}

/**
 * Linear resample to 16 kHz.
 *
 * Linear interpolation with no anti-aliasing filter, which is the honest
 * limitation here: downsampling 44.1 kHz speech folds anything above 8 kHz back
 * into the band. For speaker enrolment that is acceptable — the voice
 * characteristics Eagle uses sit well below 8 kHz, and the alternative is
 * shipping a filter design or refusing the file. If a profile enrolled from a
 * high-rate file scores its owner poorly, re-recording is the fix, and enrolling
 * live avoids the question entirely by capturing at 16 kHz to begin with.
 */
function resample(pcm: Buffer, fromRate: number): Buffer {
  if (fromRate === GATE_SAMPLE_RATE) {
    return pcm;
  }
  const inSamples = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  const outSamples = Math.floor((inSamples * GATE_SAMPLE_RATE) / fromRate);
  if (outSamples <= 0 || inSamples <= 0) {
    return Buffer.alloc(0);
  }
  const out = Buffer.alloc(outSamples * BYTES_PER_SAMPLE);
  const step = inSamples / outSamples;
  for (let i = 0; i < outSamples; i++) {
    const pos = i * step;
    const low = Math.floor(pos);
    const high = Math.min(low + 1, inSamples - 1);
    const frac = pos - low;
    const a = pcm.readInt16LE(low * BYTES_PER_SAMPLE);
    const b = pcm.readInt16LE(high * BYTES_PER_SAMPLE);
    out.writeInt16LE(Math.round(a + (b - a) * frac), i * BYTES_PER_SAMPLE);
  }
  return out;
}

/** Anything WAV cannot read. Raw output on stdout, so nothing is written to disk. */
function decodeViaFfmpeg(filePath: string, ffmpegPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      filePath,
      '-ac',
      '1',
      '-ar',
      String(GATE_SAMPLE_RATE),
      '-f',
      's16le',
      '-',
    ];
    try {
      execFile(
        ffmpegPath || 'ffmpeg',
        args,
        // A voice sample is seconds long, but the buffer is sized for minutes so
        // a generous recording is not silently truncated.
        { maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'buffer' },
        (err, stdout, stderr) => {
          if (err) {
            const detail = stderr?.toString().trim();
            reject(
              new Error(
                detail ||
                  `Could not read that audio file. ${err.message}. ` +
                    'WAV files work without ffmpeg; other formats need it installed.'
              )
            );
            return;
          }
          if (!stdout || stdout.length === 0) {
            reject(new Error('That file decoded to no audio at all.'));
            return;
          }
          resolve(stdout);
        }
      );
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
