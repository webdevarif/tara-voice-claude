// ─────────────────────────────────────────────────────────────────────────────
// MicRecorder — microphone capture in the extension host.
//
// Why not `getUserMedia` in the webview? Because it cannot work. VS Code builds
// the webview iframes with an explicit Permissions-Policy allow list and
// `microphone` is not on it — verified in 1.131.0 at both frame levels:
//
//   out/vs/workbench/contrib/webview/browser/pre/index.html
//     const allowRules = ['cross-origin-isolated;', 'autoplay;',
//                         'local-network-access;'];
//     if (!isFirefox && options.allowScripts) {
//       allowRules.push('clipboard-read;', 'clipboard-write;');
//     }
//     newFrame.setAttribute('allow', allowRules.join(' '));
//
// `microphone`'s default allowlist is `self`, and the webview frame is a
// different origin (`vscode-webview://`) from the workbench (`vscode-file://`),
// so without explicit delegation the feature is off in that frame. Blink
// enforces that before Electron's permission handler or the OS is consulted,
// which is why no VS Code setting and no Windows privacy toggle can unblock it.
// See microsoft/vscode#250568.
//
// Anthropic's own Claude Code extension reaches the same conclusion: its webview
// bundle contains zero references to `getUserMedia`, and it ships
// `resources/audio-capture/<arch>-<platform>/audio-capture.node` plus a fallback
// that shells out to `rec` (SoX) or `arecord` with
// `-r 16000 -e signed -b 16 -c 1 -t raw`. Same architecture, same wire format.
//
// So there are two backends here, tried in order:
//
//   1. pvrecorder — a bundled N-API addon with prebuilt binaries for
//      win32 x64/arm64, macOS x64/arm64, linux x64 and Raspberry Pi. Nothing to
//      install, and it hands back exactly 16 kHz signed 16-bit mono frames.
//   2. ffmpeg — for any platform the addon does not cover, or an environment
//      that refuses to load native modules.
//
// Playback stays in the webview: audio *output* needs no permission and
// `autoplay` is on the allow list.
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'events';
import { ChildProcess, execFile, spawn } from 'child_process';
import type { PvRecorder as PvRecorderInstance } from '@picovoice/pvrecorder-node';
import { buildLaunchSpec } from '../execution/AgentOrchestrator';

export const CAPTURE_SAMPLE_RATE = 16000;

/** 512 samples = 32 ms at 16 kHz — small enough that a press feels immediate. */
const PV_FRAME_LENGTH = 512;

/**
 * Measured on this machine (ffmpeg 9.0, USB condenser mic), time from spawn to
 * first PCM byte, and the delivered byte rate against the expected 32000 B/s:
 *
 *   -audio_buffer_size 50   open=438ms  rate=31024 B/s
 *   -audio_buffer_size 10   open=429ms  rate=32360 B/s
 *   (flag omitted)          open=938ms  rate=48806 B/s
 *
 * Omitting the flag is the bad case twice over: dshow's default buffer holds
 * several hundred milliseconds and is handed over in one burst at open, which
 * both doubles the latency and makes the stream arrive faster than real time.
 * 10 ms is not measurably better than 50, so 50 keeps the syscall rate down.
 *
 * For contrast, pvrecorder on the same machine and mic delivered its first
 * frame 60 ms after start() — which is why it is the preferred backend.
 */
const DSHOW_BUFFER_MS = 50;

/** ffmpeg normally dies immediately on kill(); this is the backstop. */
const STOP_GRACE_MS = 800;

/**
 * A pending pvrecorder read() should settle once stop() is called. This bounds
 * the wait so a backend that does not honour that cannot hang a release.
 */
const PV_DRAIN_TIMEOUT_MS = 500;

export type CaptureBackend = 'pvrecorder' | 'ffmpeg';

/**
 * Device ids carry their backend as a prefix — `pv:<device name>` or
 * `ff:<platform selector>`. Without it, an id persisted while one backend was
 * active could be handed to the other, which would either fail or, worse,
 * silently select a different microphone.
 */
const PREFIX: Record<CaptureBackend, string> = { pvrecorder: 'pv:', ffmpeg: 'ff:' };

export interface AudioInputDevice {
  id: string;
  label: string;
  /** True for the entry used when the user has expressed no preference. */
  isDefault?: boolean;
  backend: CaptureBackend;
}

export function deviceBackend(id: string): CaptureBackend | undefined {
  if (id.startsWith(PREFIX.pvrecorder)) {
    return 'pvrecorder';
  }
  if (id.startsWith(PREFIX.ffmpeg)) {
    return 'ffmpeg';
  }
  return undefined;
}

function deviceSelector(id: string): string {
  const backend = deviceBackend(id);
  return backend ? id.slice(PREFIX[backend].length) : id;
}

export interface FfmpegProbe {
  ok: boolean;
  /** The command that worked, for reuse by capture. */
  path?: string;
  /** First line of `ffmpeg -version`. */
  version?: string;
  error?: string;
}

export interface CaptureProbe {
  /** The backend a press would use, or undefined when capture is impossible. */
  backend?: CaptureBackend;
  bundledOk: boolean;
  bundledError?: string;
  bundledVersion?: string;
  ffmpeg: FfmpegProbe;
  devices: AudioInputDevice[];
  /** Shown only when nothing works, so the user has a next step. */
  installCommand: string;
}

/** `winget` id used by the setup screen's install hint. */
export const FFMPEG_WINGET_ID = 'Gyan.FFmpeg';

export function ffmpegInstallCommand(): string {
  switch (process.platform) {
    case 'win32':
      return `winget install --id ${FFMPEG_WINGET_ID} -e`;
    case 'darwin':
      return 'brew install ffmpeg';
    default:
      return 'sudo apt install ffmpeg';
  }
}

// ── Bundled backend (pvrecorder) ─────────────────────────────────────────────

interface PvRecorderModule {
  PvRecorder: {
    new (frameLength: number, deviceIndex?: number, bufferedFramesCount?: number):
      PvRecorderInstance;
    getAvailableDevices(): string[];
  };
}

let pvModule: PvRecorderModule | null | undefined;
let pvError: string | undefined;

/**
 * Loaded lazily and defensively. A static import would take the whole extension
 * down on any platform without a prebuilt binary, which is exactly the case the
 * ffmpeg fallback exists for.
 */
function loadPv(): PvRecorderModule | null {
  if (pvModule !== undefined) {
    return pvModule;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    pvModule = require('@picovoice/pvrecorder-node') as PvRecorderModule;
    if (typeof pvModule?.PvRecorder?.getAvailableDevices !== 'function') {
      pvError = 'The bundled audio module loaded but is missing its API.';
      pvModule = null;
    }
  } catch (err) {
    pvError = err instanceof Error ? err.message : String(err);
    pvModule = null;
  }
  return pvModule;
}

function pvDevices(): AudioInputDevice[] {
  const mod = loadPv();
  if (!mod) {
    return [];
  }
  try {
    const named = mod.PvRecorder.getAvailableDevices().map((label) => ({
      // The *name* is the id, not the index: indices shift when a device is
      // unplugged, which would silently repoint a saved preference.
      id: `${PREFIX.pvrecorder}${label}`,
      label,
      backend: 'pvrecorder' as const,
    }));
    if (!named.length) {
      return [];
    }
    // Index 0 is emphatically *not* the system default — device index -1 is, and
    // an empty selector maps to it. Measured here, opening index 0 (a webcam's
    // microphone) took 681 ms to deliver its first frame while the OS default
    // took 60 ms, so defaulting to position 0 would have made every press feel
    // slow and would record from the wrong microphone.
    return [
      {
        id: PREFIX.pvrecorder,
        label: 'System default input',
        isDefault: true,
        backend: 'pvrecorder' as const,
      },
      ...named,
    ];
  } catch (err) {
    pvError = err instanceof Error ? err.message : String(err);
    return [];
  }
}

// ── ffmpeg backend ───────────────────────────────────────────────────────────

function run(
  command: string,
  args: string[],
  timeoutMs = 10000
): Promise<{ stdout: string; stderr: string; spawnError?: string }> {
  return new Promise((resolve) => {
    const spec = buildLaunchSpec(command, args);
    if (!spec) {
      resolve({ stdout: '', stderr: '', spawnError: `${command} was not found` });
      return;
    }
    try {
      execFile(
        spec.file,
        spec.args,
        {
          timeout: timeoutMs,
          windowsHide: true,
          windowsVerbatimArguments: spec.windowsVerbatimArguments,
          maxBuffer: 4 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          // ffmpeg exits non-zero for -list_devices even on success, and writes
          // the list to stderr, so a non-zero code is not an error by itself.
          resolve({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            spawnError: err && !stdout && !stderr ? err.message : undefined,
          });
        }
      );
    } catch (err) {
      resolve({
        stdout: '',
        stderr: '',
        spawnError: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

export async function probeFfmpeg(ffmpegPath: string): Promise<FfmpegProbe> {
  const command = ffmpegPath.trim() || 'ffmpeg';
  const result = await run(command, ['-hide_banner', '-version'], 8000);
  const blob = `${result.stdout}${result.stderr}`;
  const first = blob.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  if (!/ffmpeg version/i.test(first)) {
    return { ok: false, error: result.spawnError ?? `Could not run "${command}".` };
  }
  return { ok: true, path: command, version: first.trim() };
}

/**
 * dshow prints the list to stderr, as
 *
 *   [in#0 @ 0000…] "Microphone (Realtek(R) Audio)" (audio)
 *   [in#0 @ 0000…]   Alternative name "@device_cm_{33D9A762-…}\wave_{4C4A…}"
 *
 * ffmpeg 9.0 tags each entry `(audio)`, `(video)` or `(none)` — the last for
 * things like OBS Virtual Camera. Older builds print no tag and instead group
 * the kinds under a "DirectShow audio devices" header, so both forms are handled.
 */
function parseDshowDevices(stderr: string): AudioInputDevice[] {
  const devices: AudioInputDevice[] = [];
  let inAudioSection = false;
  /**
   * Whether the most recent device line was one we kept. An "Alternative name"
   * belongs to whatever device preceded it, so this must not be inferred from
   * `devices.length` — a video device listed after an audio one would then
   * overwrite the audio device's id with the camera's.
   */
  let lastKept = false;

  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.replace(/^\[[^\]]*\]\s*/, '');

    if (/DirectShow (video|audio) devices/i.test(line)) {
      inAudioSection = /audio/i.test(line);
      continue;
    }

    const alt = line.match(/^\s*Alternative name\s+"(.+)"\s*$/i);
    if (alt) {
      if (lastKept && devices.length) {
        // Prefer the alternative name as the selector: friendly names collide.
        devices[devices.length - 1].id = `${PREFIX.ffmpeg}${alt[1]}`;
      }
      continue;
    }

    const named = line.match(/^\s*"(.+?)"\s*(?:\((audio|video|none)\))?\s*$/);
    if (!named) {
      continue;
    }
    const kind = named[2]?.toLowerCase();
    lastKept = kind ? kind === 'audio' : inAudioSection;
    if (lastKept) {
      devices.push({
        id: `${PREFIX.ffmpeg}${named[1]}`,
        label: named[1],
        backend: 'ffmpeg',
      });
    }
  }

  return devices;
}

/**
 * avfoundation prints
 *   [AVFoundation indev @ 0x…] AVFoundation audio devices:
 *   [AVFoundation indev @ 0x…] [0] Built-in Microphone
 * and the bracketed index is what `-i` takes.
 */
function parseAvfoundationDevices(stderr: string): AudioInputDevice[] {
  const devices: AudioInputDevice[] = [];
  let inAudioSection = false;
  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.replace(/^\[[^\]]*\]\s*/, '');
    if (/AVFoundation (video|audio) devices/i.test(line)) {
      inAudioSection = /audio/i.test(line);
      continue;
    }
    if (!inAudioSection) {
      continue;
    }
    const match = line.match(/^\s*\[(\d+)\]\s+(.+?)\s*$/);
    if (match) {
      devices.push({
        id: `${PREFIX.ffmpeg}${match[1]}`,
        label: match[2],
        backend: 'ffmpeg',
      });
    }
  }
  return devices;
}

async function ffmpegDevices(ffmpegPath: string): Promise<AudioInputDevice[]> {
  const command = ffmpegPath.trim() || 'ffmpeg';

  if (process.platform === 'win32') {
    const result = await run(command, [
      '-hide_banner',
      '-list_devices',
      'true',
      '-f',
      'dshow',
      '-i',
      'dummy',
    ]);
    const devices = parseDshowDevices(result.stderr || result.stdout);
    if (devices.length) {
      devices[0].isDefault = true;
    }
    return devices;
  }

  if (process.platform === 'darwin') {
    const result = await run(command, [
      '-hide_banner',
      '-f',
      'avfoundation',
      '-list_devices',
      'true',
      '-i',
      '',
    ]);
    const devices = parseAvfoundationDevices(result.stderr || result.stdout);
    if (devices.length) {
      devices[0].isDefault = true;
    }
    return devices;
  }

  // PulseAudio names its sources outside ffmpeg; "default" is the server's
  // configured input and is what the vast majority of setups want.
  return [
    {
      id: `${PREFIX.ffmpeg}default`,
      label: 'System default input',
      isDefault: true,
      backend: 'ffmpeg',
    },
  ];
}

function ffmpegInputArgs(selector: string): string[] {
  switch (process.platform) {
    case 'win32':
      return [
        '-f',
        'dshow',
        '-audio_buffer_size',
        String(DSHOW_BUFFER_MS),
        '-i',
        // dshow wants the selector inline. Passing it as one argv element means
        // no quoting of our own, so names with spaces or `(` need no escaping.
        `audio=${selector}`,
      ];
    case 'darwin':
      // avfoundation's `-i` is "video:audio"; a leading colon means audio only.
      return ['-f', 'avfoundation', '-i', `:${selector}`];
    default:
      return ['-f', 'pulse', '-i', selector || 'default'];
  }
}

// ── Probe ────────────────────────────────────────────────────────────────────

/**
 * Reports what capture is possible and lists the devices of the backend that
 * would actually be used — mixing devices from both backends in one picker
 * would offer choices that silently switch capture implementation.
 */
export async function probeCapture(ffmpegPath: string): Promise<CaptureProbe> {
  const bundled = pvDevices();
  const bundledOk = bundled.length > 0;

  // Probed even when the bundled backend works, so the setup screen can explain
  // the fallback and so a user who prefers ffmpeg can see it is available.
  const ffmpeg = await probeFfmpeg(ffmpegPath);
  const ffmpegList = ffmpeg.ok ? await ffmpegDevices(ffmpegPath) : [];

  const backend: CaptureBackend | undefined = bundledOk
    ? 'pvrecorder'
    : ffmpegList.length
      ? 'ffmpeg'
      : undefined;

  return {
    backend,
    bundledOk,
    bundledError: bundledOk ? undefined : (pvError ?? 'No capture device was reported.'),
    bundledVersion: bundledOk ? bundledVersion() : undefined,
    ffmpeg,
    devices: backend === 'pvrecorder' ? bundled : ffmpegList,
    installCommand: ffmpegInstallCommand(),
  };
}

function bundledVersion(): string | undefined {
  const mod = loadPv();
  if (!mod) {
    return undefined;
  }
  try {
    // The version is an instance getter, so this needs a throwaway handle. It
    // does not open the device — only `start()` does.
    const probe = new mod.PvRecorder(PV_FRAME_LENGTH, -1);
    const version = probe.version;
    probe.release();
    return version;
  } catch {
    return undefined;
  }
}

// ── Capture ──────────────────────────────────────────────────────────────────

export class MicRecorder extends EventEmitter {
  private child?: ChildProcess;
  private pv?: PvRecorderInstance;
  private pumpDone?: Promise<void>;
  private stderrTail: string[] = [];
  private sawAudio = false;
  private backend?: CaptureBackend;
  /**
   * Bumped by stop(). start() and the read pump check it so a release that
   * lands mid-startup cannot leave a device open with nothing reading it.
   */
  private generation = 0;

  get active(): boolean {
    return !!this.child || !!this.pv;
  }

  get activeBackend(): CaptureBackend | undefined {
    return this.backend;
  }

  /**
   * Opens the device named by `deviceId` and begins emitting `data` (raw 16 kHz
   * s16le mono PCM). `capturing` fires when the first sample actually arrives.
   */
  async start(ffmpegPath: string, deviceId: string): Promise<void> {
    if (this.active) {
      await this.stop();
    }
    const generation = ++this.generation;
    this.sawAudio = false;

    const backend = deviceBackend(deviceId) ?? (loadPv() ? 'pvrecorder' : 'ffmpeg');
    this.backend = backend;

    if (backend === 'pvrecorder') {
      this.startPv(deviceSelector(deviceId), generation);
      return;
    }
    await this.startFfmpeg(ffmpegPath, deviceSelector(deviceId), generation);
  }

  private startPv(deviceName: string, generation: number) {
    const mod = loadPv();
    if (!mod) {
      throw new Error(pvError ?? 'The bundled audio capture module is unavailable.');
    }

    // Resolve the saved *name* to an index now. -1 means the system default,
    // which is the right answer when a remembered device has gone away.
    let index = -1;
    if (deviceName) {
      try {
        const found = mod.PvRecorder.getAvailableDevices().indexOf(deviceName);
        if (found >= 0) {
          index = found;
        }
      } catch {
        /* fall through to the default device */
      }
    }

    let rec: PvRecorderInstance;
    try {
      rec = new mod.PvRecorder(PV_FRAME_LENGTH, index);
      rec.start();
    } catch (err) {
      throw new Error(
        `Could not open the microphone: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (this.generation !== generation) {
      try {
        rec.stop();
        rec.release();
      } catch {
        /* nothing to clean up */
      }
      return;
    }

    this.pv = rec;
    this.pumpDone = this.pump(rec, generation);
  }

  private async pump(rec: PvRecorderInstance, generation: number): Promise<void> {
    while (this.generation === generation) {
      let frame: Int16Array;
      try {
        frame = await rec.read();
      } catch (err) {
        // A read rejecting after stop() is the normal way out of this loop.
        if (this.generation === generation) {
          this.emit(
            'error',
            `Microphone capture failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        return;
      }
      if (this.generation !== generation) {
        return;
      }
      if (!this.sawAudio) {
        this.sawAudio = true;
        this.emit('capturing');
      }
      // Copied, not wrapped: the addon is free to reuse the frame's backing
      // store on the next read, and consumers may hold this past that point.
      const chunk = Buffer.allocUnsafe(frame.byteLength);
      Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).copy(chunk);
      this.emit('data', chunk);
    }
  }

  private async startFfmpeg(
    ffmpegPath: string,
    selector: string,
    generation: number
  ): Promise<void> {
    const command = ffmpegPath.trim() || 'ffmpeg';
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      // There is no console to answer a prompt on, so never let ffmpeg ask.
      '-nostdin',
      ...ffmpegInputArgs(selector),
      '-ac',
      '1',
      '-ar',
      String(CAPTURE_SAMPLE_RATE),
      '-f',
      's16le',
      '-',
    ];

    const spec = buildLaunchSpec(command, args);
    if (!spec) {
      throw new Error(
        `No microphone backend is available: the bundled module did not load and ffmpeg was not found at "${command}". Install it with: ${ffmpegInstallCommand()}`
      );
    }

    let child: ChildProcess;
    try {
      child = spawn(spec.file, spec.args, {
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      throw new Error(
        `Could not start ffmpeg: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (this.generation !== generation) {
      child.kill();
      return;
    }

    this.child = child;
    this.stderrTail = [];

    child.stdout?.on('data', (chunk: Buffer) => {
      if (!this.sawAudio) {
        this.sawAudio = true;
        this.emit('capturing');
      }
      this.emit('data', chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail.push(chunk.toString('utf8'));
      // Only the tail matters for diagnosis, and this must not grow unbounded
      // across a long dictation.
      if (this.stderrTail.length > 20) {
        this.stderrTail.splice(0, this.stderrTail.length - 20);
      }
    });

    child.on('error', (err: Error) => {
      if (this.child === child) {
        this.child = undefined;
      }
      this.emit('error', `Microphone capture failed: ${err.message}`);
    });

    child.on('close', (code: number | null) => {
      const wasCurrent = this.child === child;
      if (wasCurrent) {
        this.child = undefined;
      }
      // A non-zero exit before any audio means the device selector was wrong or
      // the OS refused the device. ffmpeg's own words are precise here
      // ("Could not find audio only device with name …"), so pass them through.
      if (wasCurrent && code !== 0 && code !== null && !this.sawAudio) {
        const detail = this.stderrTail.join('').trim().split(/\r?\n/).slice(-3).join(' ');
        this.emit(
          'error',
          detail
            ? `Microphone capture failed: ${detail}`
            : `ffmpeg exited with code ${code} before any audio arrived.`
        );
      }
    });
  }

  /**
   * Stops capture and resolves once the device is released, so the caller can
   * signal end-of-stream knowing no further chunks will arrive.
   */
  async stop(): Promise<void> {
    this.generation++;

    const rec = this.pv;
    this.pv = undefined;
    if (rec) {
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
      // Wait for the in-flight read to settle before releasing: freeing the
      // handle under a live read is how a native addon segfaults the host.
      const pump = this.pumpDone;
      this.pumpDone = undefined;
      if (pump) {
        await Promise.race([
          pump,
          new Promise<void>((resolve) => setTimeout(resolve, PV_DRAIN_TIMEOUT_MS)),
        ]);
      }
      try {
        rec.release();
      } catch {
        /* already released */
      }
    }

    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          // SIGTERM is not implemented on Windows, where kill() maps to
          // TerminateProcess — fine for a capture with no file to finalize.
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
          resolve();
        }, STOP_GRACE_MS);

        child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          child.kill();
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    }

    this.backend = undefined;
  }

  dispose(): void {
    void this.stop();
    this.removeAllListeners();
  }
}
