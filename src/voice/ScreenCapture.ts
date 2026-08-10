// ─────────────────────────────────────────────────────────────────────────────
// ScreenCapture — gives Tara eyes.
//
// Until now she could only be *told* what was on screen, which makes fixing
// anything visual by voice close to impossible: describing a broken layout aloud
// is slower than fixing it by hand, and the description is the part most likely
// to be wrong. The Live API takes image frames, so she can simply look.
//
// The wire format is not guesswork: a working implementation against this same
// model sends frames as `realtimeInput.video` with `mimeType: "image/jpeg"`,
// beside audio rather than inside it. That is what GeminiVoiceBridge does.
//
// Frames are captured on demand, one at a time, rather than streamed. Continuous
// screen sharing is what the API is built for — it accepts at most one frame per
// second — but it bills every frame, and "open this link and tell me what is
// wrong with it" needs one look, not sixty a minute. Streaming can be added on
// top of this; the reverse is harder.
//
// Every platform branch uses tools already present on that platform. No npm
// dependency, no native module, nothing to install — the one thing this project
// has learned to care about.
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Longest edge of the image sent to the model.
 *
 * A full 1920x1080 grab encodes to ~330 KB, and image input is billed by area,
 * so sending the raw capture pays for detail no reader needs. 1280 is wide enough
 * to read body text in a browser tab, which is the actual task.
 */
const MAX_WIDTH = 1280;

// Deliberately no JPEG quality control on Windows. The first version of this set
// one via ImageCodecInfo + EncoderParameters, and Windows Defender's AMSI refused
// to run the script at all: "This script contains malicious content and has been
// blocked by your antivirus software."
//
// That is not a false positive worth fighting. Capture the screen, downscale it,
// then re-encode it at a chosen quality is precisely the shape of an infostealer,
// and it was flagged whether the script arrived as -EncodedCommand, as -Command,
// or as a .ps1 run with -File — the content is what is scanned. Measured on this
// machine: capture alone passes, capture plus DrawImage resize passes, adding the
// encoder-parameters block fails.
//
// So the resize stays and the quality control goes. Default JPEG quality at
// 1280x720 measured 111 KB, which is small enough that the saving was never worth
// looking like malware for.

/** A capture that hangs must not take the extension host with it. */
const CAPTURE_TIMEOUT_MS = 15_000;

export interface ScreenShot {
  /** base64 image, ready for `realtimeInput.video`. */
  base64: string;
  bytes: number;
  /** Which platform tool produced it, for a message the user can act on. */
  via: string;
}

export interface ScreenCaptureProbe {
  ok: boolean;
  /** The tool that would be used, or why none can be. */
  detail: string;
}

/**
 * The Windows capture, written to a `.ps1` and run with `-File`.
 *
 * Every construct here was checked against AMSI on a real machine — see the note
 * above MAX_WIDTH's neighbour. Kept to the plainest form that works: no
 * `$ErrorActionPreference`, no `InterpolationMode`, no encoder parameters, and the
 * output path taken as `$args[0]` rather than interpolated into the script.
 *
 * It writes a file instead of returning base64 on stdout, because reading a file
 * in Node is cheaper than pushing a 150 KB base64 string through a pipe, and
 * because `[Convert]::ToBase64String` over captured pixels is another construct
 * worth not handing to a scanner.
 */
const WINDOWS_SCRIPT = `Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$w = ${MAX_WIDTH}
if ($b.Width -le $w) {
  $bmp.Save($args[0], [System.Drawing.Imaging.ImageFormat]::Jpeg)
} else {
  $h = [int]($b.Height * $w / $b.Width)
  $small = New-Object System.Drawing.Bitmap $w, $h
  $sg = [System.Drawing.Graphics]::FromImage($small)
  $sg.DrawImage($bmp, 0, 0, $w, $h)
  $small.Save($args[0], [System.Drawing.Imaging.ImageFormat]::Jpeg)
}
`;

function run(
  file: string,
  args: string[],
  encoding: 'buffer' | 'utf-8'
): Promise<{ stdout: Buffer | string }> {
  return new Promise((resolve, reject) => {
    try {
      execFile(
        file,
        args,
        {
          timeout: CAPTURE_TIMEOUT_MS,
          windowsHide: true,
          // A full-screen base64 payload is comfortably past the 1 MB default.
          maxBuffer: 64 * 1024 * 1024,
          encoding: encoding as 'buffer',
        },
        (err, stdout, stderr) => {
          const errText = Buffer.isBuffer(stderr) ? stderr.toString() : String(stderr ?? '');
          if (err) {
            reject(new Error(errText.trim() || err.message));
            return;
          }
          resolve({ stdout });
        }
      );
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

interface LinuxTool {
  file: string;
  /** Args that write an image to `out`. */
  args: (out: string) => string[];
}

/**
 * In preference order. `grim` first because a Wayland session is exactly where
 * the X11 tools produce a black image rather than failing outright.
 */
const LINUX_TOOLS: LinuxTool[] = [
  { file: 'grim', args: (out) => [out] },
  { file: 'gnome-screenshot', args: (out) => ['-f', out] },
  { file: 'spectacle', args: (out) => ['-b', '-n', '-o', out] },
  { file: 'import', args: (out) => ['-window', 'root', out] },
];

function which(command: string): string | undefined {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, command);
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Keep looking.
    }
  }
  return undefined;
}

/** What could take a screenshot here, without answering by taking one. */
export function probeScreenCapture(): ScreenCaptureProbe {
  switch (process.platform) {
    case 'win32':
      return { ok: true, detail: 'PowerShell (System.Drawing)' };
    case 'darwin':
      return { ok: true, detail: 'screencapture' };
    case 'linux': {
      const found = LINUX_TOOLS.find((t) => which(t.file));
      return found
        ? { ok: true, detail: found.file }
        : {
            ok: false,
            detail:
              'No screenshot tool found. Install one of: grim (Wayland), ' +
              'gnome-screenshot, spectacle, or ImageMagick (import).',
          };
    }
    default:
      return {
        ok: false,
        detail: `Screen capture is not implemented for ${process.platform}.`,
      };
  }
}

/**
 * Takes one screenshot of the primary display, as base64.
 *
 * Throws with a message worth showing: a failure here is usually something the
 * user can fix — a screen-recording permission on macOS, a missing tool on Linux
 * — and "screenshot failed" would tell them nothing.
 */
export async function captureScreenJpeg(): Promise<ScreenShot> {
  switch (process.platform) {
    case 'win32':
      return captureWindows();
    case 'darwin':
      return captureMac();
    case 'linux':
      return captureLinux();
    default:
      throw new Error(`Screen capture is not implemented for ${process.platform}.`);
  }
}

async function captureWindows(): Promise<ScreenShot> {
  const script = path.join(os.tmpdir(), `tara-grab-${process.pid}.ps1`);
  const out = path.join(os.tmpdir(), `tara-shot-${process.pid}.jpg`);
  try {
    await fs.promises.writeFile(script, WINDOWS_SCRIPT, 'utf8');
    // -ExecutionPolicy Bypass because a machine policy of AllSigned or Restricted
    // would otherwise refuse a file we just wrote ourselves. It relaxes signing
    // for this one invocation only and does not touch the machine's setting.
    await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, out],
      'buffer'
    );
    const buf = await fs.promises.readFile(out);
    if (!buf.length) {
      throw new Error('The screen capture produced an empty image.');
    }
    return { base64: buf.toString('base64'), bytes: buf.length, via: 'PowerShell' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Worth naming, because the user can allow it and would otherwise just see a
    // capture that never works.
    if (/malicious|blocked by your antivirus|AMSI/i.test(message)) {
      throw new Error(
        'Windows Defender blocked the screen capture script. Screen capture looks ' +
          'like an infostealer to antivirus software; allow Tara in your antivirus ' +
          'settings, or leave this feature off.'
      );
    }
    throw new Error(message);
  } finally {
    await Promise.all([
      fs.promises.rm(script, { force: true }).catch(() => {}),
      fs.promises.rm(out, { force: true }).catch(() => {}),
    ]);
  }
}

async function captureMac(): Promise<ScreenShot> {
  const out = path.join(os.tmpdir(), `tara-shot-${process.pid}.jpg`);
  try {
    // -x silences the shutter; -t jpg encodes directly.
    await run('screencapture', ['-x', '-t', 'jpg', out], 'buffer');
    // sips ships with macOS; -Z fits the longest edge and keeps the aspect ratio.
    await run('sips', ['-Z', String(MAX_WIDTH), out], 'buffer').catch(() => {
      // Resizing is an optimisation, not a requirement: a full-size frame still
      // works, it only costs more.
    });
    const buf = await fs.promises.readFile(out);
    return { base64: buf.toString('base64'), bytes: buf.length, via: 'screencapture' };
  } finally {
    await fs.promises.rm(out, { force: true }).catch(() => {
      /* best effort */
    });
  }
}

async function captureLinux(): Promise<ScreenShot> {
  const tool = LINUX_TOOLS.find((t) => which(t.file));
  if (!tool) {
    throw new Error(probeScreenCapture().detail);
  }
  // PNG, because grim and import write PNG whatever the extension says. The model
  // takes either, and re-encoding here would need an image library.
  const out = path.join(os.tmpdir(), `tara-shot-${process.pid}.png`);
  try {
    await run(tool.file, tool.args(out), 'buffer');
    const buf = await fs.promises.readFile(out);
    if (!buf.length) {
      throw new Error(`${tool.file} produced an empty image.`);
    }
    return { base64: buf.toString('base64'), bytes: buf.length, via: tool.file };
  } finally {
    await fs.promises.rm(out, { force: true }).catch(() => {
      /* best effort */
    });
  }
}

/**
 * The mime type for a captured frame.
 *
 * Windows and macOS produce JPEG; the Linux tools produce PNG whatever the
 * filename says. Declaring the wrong one shows up as the model politely ignoring
 * the image, so it is read from the bytes rather than assumed from the platform.
 * PNG begins 89 50 4E 47, which is "iVBORw" in base64; JPEG begins FF D8, "/9j".
 */
export function frameMimeType(base64: string): string {
  return base64.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
}
