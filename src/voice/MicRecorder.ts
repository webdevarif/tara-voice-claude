// ─────────────────────────────────────────────────────────────────────────────
// MicRecorder — microphone capture in the extension host, via ffmpeg.
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
// So capture happens here instead, in Node, where there is no iframe policy to
// satisfy. ffmpeg writes raw little-endian 16-bit mono PCM at 16 kHz to stdout —
// exactly the format the Gemini Live API wants, with no resampling of ours in
// the path. Playback stays in the webview: audio *output* needs no permission
// and `autoplay` is on the allow list.
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'events';
import { ChildProcess, execFile, spawn } from 'child_process';
import { buildLaunchSpec } from '../execution/AgentOrchestrator';

export const CAPTURE_SAMPLE_RATE = 16000;

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
 */
const DSHOW_BUFFER_MS = 50;

/**
 * Opening a dshow graph costs ~450 ms and a warm restart is no faster (539 ms
 * measured immediately after a previous capture), so there is nothing to gain
 * from holding the device open between utterances — which is why this class has
 * no keep-alive. The cost is paid per press, and the UI has to say so: callers
 * should not claim to be listening until `capturing` fires.
 */
export const TYPICAL_OPEN_LATENCY_MS = 450;

/** ffmpeg normally dies immediately on kill(); this is the backstop. */
const STOP_GRACE_MS = 800;

export interface AudioInputDevice {
  /**
   * Opaque, platform-specific, and passed straight back to ffmpeg. On Windows
   * this is dshow's "Alternative name" where one exists, because friendly names
   * are not unique — two identical headsets produce two identical labels.
   */
  id: string;
  label: string;
  /** True for the entry we would pick if the user has expressed no preference. */
  isDefault?: boolean;
}

export interface FfmpegProbe {
  ok: boolean;
  /** The command that worked, for reuse by capture. */
  path?: string;
  /** First line of `ffmpeg -version`. */
  version?: string;
  error?: string;
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

// ── Device enumeration ───────────────────────────────────────────────────────

/**
 * dshow prints the list to stderr, as
 *
 *   [dshow @ 0000…] "Microphone (Realtek(R) Audio)" (audio)
 *   [dshow @ 0000…]   Alternative name "@device_cm_{33D9A762-…}\wave_{4C4A…}"
 *
 * Older builds omit the `(audio)` suffix and instead separate video from audio
 * with a "DirectShow audio devices" header, so both forms are handled.
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
        // Prefer the alternative name as the id: friendly names collide.
        devices[devices.length - 1].id = alt[1];
      }
      continue;
    }

    // ffmpeg 9.0 tags every entry — `(audio)`, `(video)`, or `(none)` for things
    // like OBS Virtual Camera. Older builds print no tag and instead group the
    // kinds under a header, which `inAudioSection` covers.
    const named = line.match(/^\s*"(.+?)"\s*(?:\((audio|video|none)\))?\s*$/);
    if (!named) {
      continue;
    }
    const kind = named[2]?.toLowerCase();
    lastKept = kind ? kind === 'audio' : inAudioSection;
    if (lastKept) {
      devices.push({ id: named[1], label: named[1] });
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
      devices.push({ id: match[1], label: match[2] });
    }
  }
  return devices;
}

export async function listInputDevices(ffmpegPath: string): Promise<AudioInputDevice[]> {
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
  return [{ id: 'default', label: 'System default input', isDefault: true }];
}

// ── Capture ──────────────────────────────────────────────────────────────────

function inputArgs(deviceId: string): string[] {
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
        `audio=${deviceId}`,
      ];
    case 'darwin':
      // avfoundation's `-i` is "video:audio"; a leading colon means audio only.
      return ['-f', 'avfoundation', '-i', `:${deviceId}`];
    default:
      return ['-f', 'pulse', '-i', deviceId || 'default'];
  }
}

export class MicRecorder extends EventEmitter {
  private child?: ChildProcess;
  private stderrTail: string[] = [];
  private sawAudio = false;
  /**
   * Bumped by stop(). start() checks it after spawning so a release that lands
   * mid-startup cannot leave an orphaned ffmpeg holding the microphone open.
   */
  private generation = 0;

  get active(): boolean {
    return !!this.child;
  }

  /**
   * Spawns ffmpeg and begins emitting `data` (raw 16 kHz s16le mono PCM).
   * Resolves once the process is running; the first chunk follows a few tens of
   * milliseconds later, at which point `capturing` fires.
   */
  async start(ffmpegPath: string, deviceId: string): Promise<void> {
    if (this.child) {
      await this.stop();
    }
    const generation = ++this.generation;

    const command = ffmpegPath.trim() || 'ffmpeg';
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      // There is no console to answer a prompt on, so never let ffmpeg ask.
      '-nostdin',
      ...inputArgs(deviceId),
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
        `ffmpeg was not found at "${command}". Install it with: ${ffmpegInstallCommand()}`
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
    this.sawAudio = false;

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
   * Stops capture and resolves once ffmpeg is gone, so the caller can signal
   * end-of-stream to Gemini knowing no further chunks will arrive.
   */
  async stop(): Promise<void> {
    this.generation++;
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) {
      return;
    }

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

  dispose(): void {
    void this.stop();
    this.removeAllListeners();
  }
}
