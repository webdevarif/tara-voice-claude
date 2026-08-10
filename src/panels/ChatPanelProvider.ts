import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import {
  AgentOrchestrator,
  AgentOutput,
  buildLaunchSpec,
} from '../execution/AgentOrchestrator';
import {
  GEMINI_OUTPUT_SAMPLE_RATE,
  GeminiVoiceBridge,
  LiveToolCall,
  RUN_TASK_TOOL,
  VoiceState,
} from '../voice/GeminiVoiceBridge';
import {
  AudioInputDevice,
  CaptureBackend,
  MicRecorder,
  ffmpegInstallCommand,
  probeCapture,
} from '../voice/MicRecorder';
import { verifyGeminiKey } from '../voice/GeminiKeyCheck';
import { Vad, chunkRms } from '../voice/Vad';
import { ConversationStore } from '../history/ConversationStore';
import {
  AudioOutputDevice,
  SpeakerPlayer,
  probeSpeakers,
} from '../voice/SpeakerPlayer';
import {
  LanguageOption,
  LiveModelOption,
  PREBUILT_VOICES,
  SPOKEN_LANGUAGES,
  VoiceOption,
  listLiveModels,
} from '../voice/GeminiCatalog';
import { AgentStatus, ChatEntry, TaraMessage, isRiskyCommand } from '../types';

/** SecretStorage key. Superseded the `tara.geminiApiKey` setting, which leaked via settings sync. */
const SECRET_GEMINI_KEY = 'tara.geminiApiKey';
const STATE_SETUP_COMPLETE = 'tara.setupComplete';
const STATE_MIC_DEVICE = 'tara.micDeviceId';
const STATE_SPEAKER_DEVICE = 'tara.speakerDeviceId';
/**
 * Whether the key currently in SecretStorage has been proven to work. Only
 * `setApiKey` writes the key, so this cannot drift away from it. A key that
 * predates verification — or one migrated out of the old plaintext setting —
 * arrives with this false and is checked once on the next setup check.
 */
const STATE_KEY_VERIFIED = 'tara.geminiKeyVerified';

/** Keeps the retained webview from growing without bound over a long session. */
const MAX_HISTORY_ENTRIES = 400;

/** Gemini returns 24 kHz signed 16-bit mono, so one second is 48000 bytes. */
const OUTPUT_BYTES_PER_SECOND = GEMINI_OUTPUT_SAMPLE_RATE * 2;

interface SetupStatus {
  /** True only for a key that is stored *and* verified against the API. */
  geminiKey: boolean;
  /** Why the last key was refused, if it was. */
  apiKeyError?: string;
  /** Key works, but the configured Live model looks wrong. Not a blocker. */
  apiKeyModelWarning?: string;
  claudeInstalled: boolean;
  claudeVersion?: string;
  claudeAuthed: boolean;
  claudeAuthDetail?: string;
  /**
   * Capture runs in this process, not the webview, because VS Code's webview
   * iframes are built without `microphone` in their Permissions-Policy allow
   * list — see the header of MicRecorder.ts.
   */
  captureBackend?: CaptureBackend;
  /** True when the bundled native recorder loaded — the no-install path. */
  bundledCaptureOk: boolean;
  bundledCaptureError?: string;
  bundledCaptureVersion?: string;
  ffmpegInstalled: boolean;
  ffmpegVersion?: string;
  ffmpegError?: string;
  ffmpegInstallCommand: string;
  micDevices: AudioInputDevice[];
  micDeviceId: string;
  /**
   * Output devices, named. This is only possible because playback runs in the
   * host: a webview cannot read device labels without a media permission.
   */
  speakerDevices: AudioOutputDevice[];
  speakerDeviceId: string;
  speakerError?: string;
  /** Current `tara.voiceName`, plus the documented set to choose from. */
  voiceName: string;
  voiceOptions: VoiceOption[];
  /** Current `tara.geminiLiveModel`, plus what this key can open a session with. */
  liveModel: string;
  /** Empty when the key is missing or the listing failed — not "no models". */
  liveModelOptions: LiveModelOption[];
  /** Current `tara.language` — a code from languageOptions, or 'auto'. */
  language: string;
  languageOptions: LanguageOption[];
  speakResponses: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// ChatPanelProvider — webview host for the Tara chat UI
// ─────────────────────────────────────────────────────────────────────────────
export class ChatPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private voiceBridge?: GeminiVoiceBridge;
  private history: ChatEntry[] = [];
  private pendingConfirmation?: { prompt: string; replyToAgentId?: string };
  private viewDisposables: vscode.Disposable[] = [];
  /** Microphone capture, in this process rather than the webview. */
  private readonly recorder = new MicRecorder();
  /**
   * Local speech gate. With the microphone open continuously, this is what keeps
   * a silent room from being streamed to — and billed by — the Live API.
   */
  private readonly vad = new Vad();
  /**
   * Per-project history, kept outside VS Code's extension storage so that
   * uninstalling and reinstalling does not erase it. See the module header.
   */
  private readonly store: ConversationStore;
  /** Playback, also in this process — see SpeakerPlayer's header for why. */
  private readonly speaker = new SpeakerPlayer();
  /** Cached from the last setup check so a press does not re-probe. */
  private micDevices: AudioInputDevice[] = [];
  private bytesThisUtterance = 0;
  /** Carried into the next SETUP_STATUS so the setup screen can explain itself. */
  private apiKeyError = '';
  private apiKeyModelWarning = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly orchestrator: AgentOrchestrator
  ) {
    // The first workspace folder identifies the project. A window with no folder
    // open gets its own bucket rather than borrowing another project's history.
    this.store = new ConversationStore(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''
    );
    this.history = this.store.entriesForActive().slice();

    // Every chunk is examined locally; only some of them are sent on.
    this.recorder.on('data', (chunk: Buffer) => this.handleAudioChunk(chunk));
    this.recorder.on('capturing', () => this.postMicState());
    this.recorder.on('error', (message: string) => {
      this.micEnabled = false;
      this.postMicState();
      this.postMessage({ type: 'ERROR', payload: { message } });
    });

    this.vad.on('speechStart', () => void this.onSpeechStart());
    this.vad.on('speechEnd', () => void this.onSpeechEnd());

    // Wired once, in the constructor. Doing this in resolveWebviewView would add
    // a duplicate listener every time the view is recreated.
    this.orchestrator.onOutput((agentId, data) => this.handleAgentOutput(agentId, data));

    this.orchestrator.onStatusChange((status: AgentStatus) => {
      this.postMessage({
        type: 'AGENT_STATUS',
        payload: {
          status,
          awaitingInput: this.orchestrator.hasAgentAwaitingInput(),
        },
      });
    });

    this.orchestrator.onQuestion((agentId, title, question) => {
      // The question text already reached the transcript as AGENT_OUTPUT; this
      // message only tells the UI that a reply is expected, and from whom.
      this.postMessage({
        type: 'AGENT_QUESTION',
        payload: { agentId, title, question },
      });
      void this.speak(question);
      void vscode.window
        .showInformationMessage(`Tara needs an answer — "${title}"`, 'Open Chat')
        .then((choice) => {
          if (choice === 'Open Chat') {
            void vscode.commands.executeCommand('tara.chatView.focus');
          }
        });
    });
  }

  // ── Webview lifecycle ──────────────────────────────────────────────────────

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        vscode.Uri.joinPath(this.context.extensionUri, 'webview-ui', 'dist'),
      ],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);

    // Scoped to this view instance so a recreated view does not stack handlers.
    this.disposeViewListeners();
    this.viewDisposables.push(
      webviewView.webview.onDidReceiveMessage((msg: TaraMessage) => {
        // A rejection here used to vanish, which could leave the setup screen
        // spinning with no explanation.
        void this.handleWebviewMessage(msg).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.postMessage({ type: 'ERROR', payload: { message } });
        });
      }),
      webviewView.onDidChangeVisibility(() => {
        void vscode.commands.executeCommand(
          'setContext',
          'tara.chatViewFocused',
          webviewView.visible
        );
      }),
      webviewView.onDidDispose(() => {
        this.disposeViewListeners();
        this.view = undefined;
      })
    );

    void this.postInit();
  }

  private disposeViewListeners() {
    for (const d of this.viewDisposables) {
      d.dispose();
    }
    this.viewDisposables = [];
  }

  private postSessions() {
    this.postMessage({
      type: 'SESSIONS',
      payload: { sessions: this.store.listSessions(), activeId: this.store.activeId },
    });
  }

  private async postInit() {
    this.postMessage({
      type: 'INIT',
      payload: {
        history: this.history,
        sessions: this.store.listSessions(),
        activeSessionId: this.store.activeId,
        setupComplete: this.context.globalState.get<boolean>(STATE_SETUP_COMPLETE, false),
        micDeviceId: this.context.globalState.get<string>(STATE_MIC_DEVICE, ''),
        agentStatus: this.orchestrator.aggregateStatus(),
        awaitingInput: this.orchestrator.hasAgentAwaitingInput(),
      },
    });
  }

  // ── Secrets ────────────────────────────────────────────────────────────────

  /**
   * Reads the key from SecretStorage, migrating it out of settings on first run.
   * The old `tara.geminiApiKey` setting travelled through Settings Sync in
   * plaintext, so it is cleared once copied.
   */
  private async getApiKey(): Promise<string> {
    const stored = await this.context.secrets.get(SECRET_GEMINI_KEY);
    if (stored) {
      return stored;
    }

    const config = vscode.workspace.getConfiguration('tara');
    const legacy = (config.get<string>('geminiApiKey') ?? '').trim();
    if (!legacy) {
      return '';
    }

    await this.context.secrets.store(SECRET_GEMINI_KEY, legacy);
    for (const target of [
      vscode.ConfigurationTarget.Global,
      vscode.ConfigurationTarget.Workspace,
      vscode.ConfigurationTarget.WorkspaceFolder,
    ]) {
      try {
        await config.update('geminiApiKey', undefined, target);
      } catch {
        // Not set at that scope — nothing to clear.
      }
    }
    return legacy;
  }

  /**
   * The only writer of the key, so it is also the only writer of the verified
   * flag — the two cannot drift apart.
   */
  private async setApiKey(key: string, verified: boolean) {
    const trimmed = key.trim();
    if (trimmed) {
      await this.context.secrets.store(SECRET_GEMINI_KEY, trimmed);
    } else {
      await this.context.secrets.delete(SECRET_GEMINI_KEY);
    }
    await this.context.globalState.update(STATE_KEY_VERIFIED, trimmed ? verified : false);
  }

  private liveModel(): string {
    return (
      vscode.workspace.getConfiguration('tara').get<string>('geminiLiveModel') ?? ''
    );
  }

  /**
   * Writes one of the voice settings and drops any open session, because the
   * voice and the model are fixed in the Live setup frame — an existing socket
   * would keep using the old ones until it happened to be replaced.
   */
  private async updateVoiceSetting(
    key: 'voiceName' | 'geminiLiveModel' | 'speakResponses' | 'language',
    value: string | boolean | undefined
  ) {
    if (value === undefined || value === '') {
      return;
    }
    await vscode.workspace
      .getConfiguration('tara')
      .update(key, value, vscode.ConfigurationTarget.Global);
    // The language lives in the system instruction, which is part of the same
    // one-shot setup frame as the voice and the model — so it needs the same
    // teardown. Changing it on a live socket would do nothing until that socket
    // happened to be replaced.
    if (key !== 'speakResponses') {
      this.voiceBridge?.dispose();
      this.voiceBridge = undefined;
    }
    await this.runSetupCheck();
  }

  /**
   * Checks a candidate key and stores it only if the API accepts it. A key that
   * cannot be reached for verification is not stored either — otherwise "saved"
   * would mean nothing more than "typed".
   */
  private async saveApiKeyIfValid(candidate: string) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      // An empty box means "forget my key"; there is nothing to verify.
      await this.setApiKey('', false);
      this.apiKeyError = '';
      this.apiKeyModelWarning = '';
      this.voiceBridge?.dispose();
      this.voiceBridge = undefined;
      await this.runSetupCheck();
      return;
    }

    const result = await verifyGeminiKey(trimmed, this.liveModel());
    if (!result.ok) {
      this.apiKeyError = result.reachable
        ? (result.message ?? 'That key was rejected.')
        : `${result.message ?? 'Could not verify the key.'} The key was not saved.`;
      this.apiKeyModelWarning = '';
      // Deliberately no store: an unverified key must not linger and then fail
      // later, mid-utterance, as an opaque WebSocket close.
      await this.runSetupCheck();
      return;
    }

    this.apiKeyError = '';
    this.apiKeyModelWarning = result.modelWarning ?? '';
    await this.setApiKey(trimmed, true);
    // A new key makes any open session stale.
    this.voiceBridge?.dispose();
    this.voiceBridge = undefined;
    await this.runSetupCheck();
  }

  // ── Voice ──────────────────────────────────────────────────────────────────

  private voiceDisabled(): boolean {
    return (
      vscode.workspace.getConfiguration('tara').get<string>('voiceMode', 'hands-free') ===
      'disabled'
    );
  }

  triggerVoiceStart() {
    if (this.voiceDisabled()) {
      void vscode.window.showInformationMessage(
        'Tara: voice input is disabled. Set "tara.voiceMode" to "hands-free" to enable it.'
      );
      return;
    }
    this.postMessage({ type: 'AGENT_STATUS', payload: { action: 'triggerVoice' } });
  }

  private async getOrCreateVoiceBridge(): Promise<GeminiVoiceBridge | undefined> {
    if (this.voiceBridge) {
      return this.voiceBridge;
    }

    const apiKey = await this.getApiKey();
    if (!apiKey) {
      this.postMessage({
        type: 'ERROR',
        payload: { message: 'Gemini API key is not set — add it in Tara setup.' },
      });
      return undefined;
    }

    const config = vscode.workspace.getConfiguration('tara');
    const bridge = new GeminiVoiceBridge({
      apiKey,
      model: config.get<string>('geminiLiveModel', ''),
      voiceName: config.get<string>('voiceName', 'Aoede'),
      language: config.get<string>('language', 'auto'),
    });

    bridge.on('state', (state: VoiceState) => {
      this.postMessage({ type: 'VOICE_STATE', payload: { state } });
    });
    bridge.on('transcriptPartial', (text: string) => {
      this.postMessage({
        type: 'TRANSCRIPT_TOKEN',
        payload: { token: text, partial: true },
      });
    });
    bridge.on('transcriptToken', (text: string) => {
      this.postMessage({ type: 'TRANSCRIPT_TOKEN', payload: { token: text } });
    });
    bridge.on('transcriptDone', (transcript: string) => {
      // Recorded, not dispatched. Dispatch is `toolCall`'s job now — see
      // handleToolCall. While asleep this is only ever a wake check.
      void this.handleTranscript(transcript);
    });
    bridge.on('spokenText', (text: string) => {
      // What Tara herself said. Accumulated rather than posted per fragment, so
      // the transcript gets one bubble per utterance instead of a dozen. Capped,
      // because a turn whose `turnComplete` never arrives would otherwise grow
      // this string for as long as the session lasts.
      if (this.taraSpeech.length < 8000) {
        this.taraSpeech += text;
      }
    });
    bridge.on('toolCall', (call: LiveToolCall, epoch: number) => {
      this.handleToolCall(bridge, call, epoch);
    });
    bridge.on('toolCancel', (ids: string[]) => {
      for (const id of ids) {
        const agentId = this.agentByToolCall.get(id);
        if (agentId) {
          this.orchestrator.stopAgent(agentId);
          this.agentByToolCall.delete(id);
          this.toolCallByAgent.delete(agentId);
        }
      }
    });
    bridge.on('ttsChunk', (base64: string) => {
      const pcm = Buffer.from(base64, 'base64');
      // While asleep every burst near the mic still reaches Gemini, and Gemini
      // still answers it — that is unavoidable, the API always answers a turn.
      // What is avoidable is playing that answer to a room Tara was not
      // addressed in.
      if (this.wakeProbe) {
        return;
      }
      // Counted before playing, and for both playback paths, so the echo gate
      // knows how long the room will be loud regardless of who is speaking.
      this.holdOutput(pcm.length);
      // Played here when the bundled output module is available, so the user can
      // choose a named device. The webview's PcmPlayer is the fallback for
      // platforms without a prebuilt binary.
      if (this.speaker.available) {
        this.speaker.enqueue(pcm);
      } else {
        this.postMessage({ type: 'TTS_AUDIO_CHUNK', payload: { base64 } });
      }
    });
    bridge.on('interrupted', () => {
      // The server threw away the rest of its generation, so what is still
      // queued here is the tail of a sentence it has abandoned. Playing it out
      // is the "half a reply, then nothing" symptom; drop it instead.
      this.speaker.reset();
      this.outputBusyUntil = 0;
      this.flushTaraSpeech();
      this.postMessage({ type: 'TTS_DONE', payload: {} });
    });
    bridge.on('ttsDone', () => {
      // Releases anything still under the prebuffer threshold; a reply shorter
      // than 250 ms would otherwise sit in the queue and never play.
      this.speaker.endOfStream();
      this.flushTaraSpeech();
      this.postMessage({ type: 'TTS_DONE', payload: {} });
    });
    bridge.on('languageCodeDropped', (why: string) => {
      // Worth saying rather than swallowing: the language still applies, but
      // through the prompt alone, and that is a weaker guarantee than the field.
      // Someone debugging "it answered in English again" needs to know which of
      // the two mechanisms is actually in play.
      this.addSystemMessage(
        `This model would not take a language code (${why}), so the language is ` +
          'set by instruction only. Voice is working.'
      );
    });
    bridge.on('error', (message: string) => {
      this.postMessage({ type: 'ERROR', payload: { message } });
    });

    this.voiceBridge = bridge;
    try {
      await bridge.connect();
    } catch (err) {
      this.postMessage({
        type: 'ERROR',
        payload: {
          message: err instanceof Error ? err.message : 'Could not reach Gemini Live.',
        },
      });
      bridge.dispose();
      this.voiceBridge = undefined;
      return undefined;
    }
    return bridge;
  }

  /**
   * How much of an answer to read out. Past this it stops being useful — nobody
   * listens to four paragraphs of prose read at conversational speed — so the
   * text is cut at a sentence end and the rest is left on screen to read.
   */
  private static readonly MAX_SPOKEN_CHARS = 700;

  /**
   * Turns an agent's answer into something worth hearing. Code blocks, paths and
   * bullet markers are unlistenable read aloud, and reading them is what makes
   * spoken output feel broken rather than helpful.
   */
  static toSpeech(text: string): string {
    let spoken = text
      // Fenced code: say that it happened instead of reading the contents.
      .replace(/```[\s\S]*?```/g, ' (code omitted) ')
      .replace(/`([^`]+)`/g, '$1')
      // Markdown emphasis and headings carry nothing in speech.
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$)/g, '$1$2')
      .replace(/^\s*[-*+]\s+/gm, '')
      // Links: keep the words, drop the URL.
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();

    if (spoken.length <= ChatPanelProvider.MAX_SPOKEN_CHARS) {
      return spoken;
    }
    const cut = spoken.slice(0, ChatPanelProvider.MAX_SPOKEN_CHARS);
    // Prefer a sentence boundary, but only if one is reasonably near the end —
    // otherwise a text with no punctuation would be cut to almost nothing.
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    spoken = lastStop > ChatPanelProvider.MAX_SPOKEN_CHARS * 0.5 ? cut.slice(0, lastStop + 1) : cut;
    return `${spoken.trim()} — the rest is on screen.`;
  }

  /**
   * Speaks `text` when `tara.speakResponses` is on, opening a session if one is
   * not already up. It used to return early without a bridge, which meant an
   * answer typed rather than dictated was never spoken at all.
   */
  private async speak(text: string) {
    if (!vscode.workspace.getConfiguration('tara').get<boolean>('speakResponses', true)) {
      return;
    }
    const spoken = ChatPanelProvider.toSpeech(text);
    if (!spoken) {
      return;
    }
    const bridge = await this.getOrCreateVoiceBridge();
    if (!bridge) {
      return;
    }
    try {
      await bridge.speak(spoken);
    } catch {
      // Speech is a nicety — never let it break the task flow.
    }
  }

  // ── Capture ────────────────────────────────────────────────────────────────

  private ffmpegPath(): string {
    return vscode.workspace.getConfiguration('tara').get<string>('ffmpegPath') || 'ffmpeg';
  }

  /**
   * The stored id, if that device is still offered by the active backend.
   * Unplugging a USB mic retires an id, and a backend switch invalidates every
   * id it wrote — falling back to the default beats failing to record.
   */
  private async resolveMicDevice(): Promise<string | undefined> {
    const stored = this.context.globalState.get<string>(STATE_MIC_DEVICE, '');
    if (!this.micDevices.length) {
      this.micDevices = (await probeCapture(this.ffmpegPath())).devices;
    }
    if (stored && this.micDevices.some((d) => d.id === stored)) {
      return stored;
    }
    return this.micDevices[0]?.id;
  }

  // ── Hands-free session ─────────────────────────────────────────────────────
  //
  // The microphone stays open for as long as it is switched on. What it does
  // *not* do is stay connected: audio is only streamed to Gemini between a local
  // speech-start and speech-end, so a silent room costs nothing. After
  // SLEEP_AFTER_MS with nothing said, it stops listening for commands at all and
  // waits for the wake phrase — which still costs one short turn per burst of
  // speech near the mic, but only per burst.

  private static readonly SLEEP_AFTER_MS = 15000;
  /** A wake phrase is short; anything longer is someone talking about something else. */
  private static readonly WAKE_BURST_LIMIT_MS = 4000;
  private static readonly WAKE_PHRASE = /\bwake\s*up\b/i;
  /**
   * Audio kept from just before speech was declared. The gate needs a few frames
   * to be sure, so without this the turn opens after the first syllable and the
   * transcript loses the start of the sentence — fatal for a two-word wake
   * phrase.
   */
  private static readonly PREROLL_BYTES = 16000 * 2 * 0.3;

  private micEnabled = false;
  private awake = true;
  /** A Gemini turn is open and chunks are being forwarded. */
  private streaming = false;
  /** The open turn is a wake-phrase probe, so its transcript is not a command. */
  private wakeProbe = false;
  private sleepTimer?: NodeJS.Timeout;
  private burstTimer?: NodeJS.Timeout;
  private preroll: Buffer[] = [];
  private prerollBytes = 0;

  // ── Echo gate ──────────────────────────────────────────────────────────────
  //
  // Hands-free listening plus a loudspeaker in the same room is a feedback loop,
  // and it was the loudest of the bugs behind "choppy, sometimes nothing". Tara
  // starts speaking, the microphone hears her, the local VAD calls it speech, a
  // new turn opens — and on the old code that also flipped the playback flag, so
  // her own sentence was cut off mid-word. Her words were then transcribed and
  // dispatched as if the user had said them.
  //
  // The fix is to know when the room is loud with our own audio. Every byte of
  // model audio is 1/48000 of a second (24 kHz, 16-bit mono), so the moment
  // playback will finish is arithmetic — no need to ask the device, and it works
  // for the webview fallback path too, which cannot be asked at all.

  /** Wall-clock ms until our own audio should have stopped playing. */
  private outputBusyUntil = 0;
  /**
   * Extra quiet time after playback. Covers the device's own buffering and the
   * tail of a room's reverb, both of which outlast the last sample.
   */
  private static readonly ECHO_TAIL_MS = 400;

  /**
   * Learned loudness of our own audio as the microphone hears it.
   *
   * Measured rather than configured, because the right number depends on speaker
   * volume, microphone gain and the room — three things no default can know. The
   * first few chunks of every reply teach it; after that anything much louder is
   * someone talking over her.
   */
  private echoLevel = 0;
  private echoChunks = 0;
  private bargeRun = 0;

  /** How much louder than our own echo counts as the user interrupting. */
  private static readonly BARGE_RATIO = 2.5;
  /** Absolute floor, so a very quiet reply cannot make ordinary room noise a barge-in. */
  private static readonly BARGE_MIN_LEVEL = 1200;
  /** Chunks spent learning the echo level before barge-in is armed. */
  private static readonly BARGE_LEARN_CHUNKS = 8;
  /** Consecutive loud chunks required, so one door slam is not an interruption. */
  private static readonly BARGE_CONFIRM_CHUNKS = 2;

  private holdOutput(bytes: number) {
    if (!this.outputBusy) {
      // A fresh utterance. The level learned from the last one was measured at
      // whatever the volume was then, and the gap may have been long enough for
      // the user to have changed it.
      this.echoLevel = 0;
      this.echoChunks = 0;
      this.bargeRun = 0;
    }
    const ms = (bytes / (OUTPUT_BYTES_PER_SECOND / 1000)) | 0;
    const from = Math.max(Date.now(), this.outputBusyUntil);
    this.outputBusyUntil = from + ms;
  }

  /**
   * The user talked over a reply.
   *
   * Playback stops here rather than when the model's own turn ends, because the
   * audio already queued would otherwise keep talking over someone who has
   * plainly stopped listening. The model is not told explicitly — capture resumes
   * immediately, and its own server-side VAD raises `interrupted` from the audio
   * it then receives.
   */
  private bargeIn() {
    this.speaker.reset();
    this.outputBusyUntil = 0;
    this.echoLevel = 0;
    this.echoChunks = 0;
    this.bargeRun = 0;
    this.vad.reset();
    this.postMessage({ type: 'TTS_DONE', payload: {} });
  }

  private get outputBusy(): boolean {
    return Date.now() < this.outputBusyUntil + ChatPanelProvider.ECHO_TAIL_MS;
  }

  // ── Tool calls ─────────────────────────────────────────────────────────────

  /** What Tara has said in the current turn, for one bubble per utterance. */
  private taraSpeech = '';
  /** Live tool calls waiting on an agent, both ways, so either end can find the other. */
  private readonly toolCallByAgent = new Map<
    string,
    { id: string; name: string; epoch: number }
  >();
  private readonly agentByToolCall = new Map<string, string>();

  private flushTaraSpeech() {
    const text = this.taraSpeech.trim();
    this.taraSpeech = '';
    if (!text) {
      return;
    }
    this.addEntry('tara', text);
    this.postMessage({ type: 'AGENT_OUTPUT', payload: { type: 'tara', text } });
  }

  /**
   * The model has decided the user wants work done. This is the dispatch point,
   * and it fires while the model is still talking — which is the whole latency
   * win over the old design, where dispatch waited for a transcript that only
   * finalized once a discarded spoken answer had finished generating.
   */
  private handleToolCall(bridge: GeminiVoiceBridge, call: LiveToolCall, epoch: number) {
    if (call.name !== RUN_TASK_TOOL) {
      bridge.sendToolResponse(
        { id: call.id, name: call.name, epoch },
        { error: `Unknown tool "${call.name}".` },
        'SILENT'
      );
      return;
    }

    const task = typeof call.args.task === 'string' ? call.args.task.trim() : '';
    if (!task) {
      bridge.sendToolResponse(
        { id: call.id, name: call.name, epoch },
        { error: 'No task was given. Ask the user what they want done.' }
      );
      return;
    }

    // Overheard speech must never reach an agent. The model does not know it is
    // being ignored, so it is told, rather than left waiting for a response.
    if (this.wakeProbe) {
      bridge.sendToolResponse(
        { id: call.id, name: call.name, epoch },
        { error: 'Tara is asleep and was not addressed. Nothing was run.' },
        'SILENT'
      );
      return;
    }

    if (this.shouldConfirm(task)) {
      bridge.sendToolResponse(
        { id: call.id, name: call.name, epoch },
        {
          status: 'awaiting_confirmation',
          detail: 'That looks destructive, so the user has been asked to confirm it.',
        }
      );
      this.requestConfirmation(task);
      return;
    }

    let agentId: string;
    try {
      agentId = this.orchestrator.runTask(task);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.addSystemMessage(message);
      bridge.sendToolResponse({ id: call.id, name: call.name, epoch }, { error: message });
      return;
    }

    this.toolCallByAgent.set(agentId, { id: call.id, name: call.name, epoch });
    this.agentByToolCall.set(call.id, agentId);
    // Shown because the model paraphrases: the user should be able to see what
    // was actually asked of Claude, not just what they said.
    this.addSystemMessage(`→ Claude: ${task}`);
  }

  /**
   * Hands an agent's outcome back to the conversation. Through the tool response
   * when the model asked for it — so Tara reads it out in the user's language,
   * inside the same turn-taking — and by speaking it directly when the task came
   * from the text box, where there is no call to answer.
   */
  private deliverAgentResult(agentId: string, text: string, failed: boolean) {
    const call = this.toolCallByAgent.get(agentId);
    if (!call) {
      void this.speak(text);
      return;
    }
    this.toolCallByAgent.delete(agentId);
    this.agentByToolCall.delete(call.id);

    const summary = ChatPanelProvider.toSpeech(text);
    // With `speakResponses` off the model must still *learn* the outcome — a
    // follow-up like "did that work?" depends on it being in the conversation —
    // but it should not announce it. That is exactly what SILENT is for.
    const scheduling = vscode.workspace
      .getConfiguration('tara')
      .get<boolean>('speakResponses', true)
      ? 'INTERRUPT'
      : 'SILENT';
    const delivered = this.voiceBridge?.sendToolResponse(
      call,
      failed ? { error: summary } : { result: summary },
      scheduling
    );
    if (!delivered) {
      // The session that asked is gone, so its call id means nothing now. Say it
      // as a fresh utterance rather than dropping the answer on the floor.
      void this.speak(text);
    }
  }

  private micState(): 'off' | 'listening' | 'hearing' | 'asleep' {
    if (!this.micEnabled) {
      return 'off';
    }
    if (!this.awake) {
      return 'asleep';
    }
    return this.streaming ? 'hearing' : 'listening';
  }

  private postMicState() {
    this.postMessage({ type: 'VOICE_STATE', payload: { mic: this.micState() } });
  }

  /** Switched from the orb. Idempotent, so a double click cannot open two devices. */
  async setMicEnabled(enabled: boolean): Promise<void> {
    if (this.voiceDisabled() && enabled) {
      this.addSystemMessage('Voice input is disabled — set "tara.voiceMode" to enable it.');
      return;
    }
    if (enabled === this.micEnabled) {
      return;
    }

    if (!enabled) {
      this.micEnabled = false;
      this.clearTimers();
      await this.endTurn();
      await this.recorder.stop();
      this.vad.reset();
      this.preroll = [];
      this.prerollBytes = 0;
      // Switching the microphone off is the clearest possible statement that
      // nothing is coming, and the connection is what costs money. Kept open only
      // while an agent still owes this session a tool response.
      if (this.toolCallByAgent.size === 0) {
        this.voiceBridge?.disconnect();
      }
      this.postMicState();
      return;
    }

    const deviceId = await this.resolveMicDevice();
    if (!deviceId) {
      this.postMessage({
        type: 'ERROR',
        payload: {
          message: this.micDevices.length
            ? 'No microphone selected.'
            : 'No microphone was found — check that a capture device is connected, then re-run the setup check.',
        },
      });
      return;
    }

    this.vad.reset();
    this.awake = true;
    this.micEnabled = true;
    this.postMicState();

    try {
      await this.recorder.start(this.ffmpegPath(), deviceId);
    } catch (err) {
      this.micEnabled = false;
      this.postMicState();
      this.postMessage({
        type: 'ERROR',
        payload: {
          message: err instanceof Error ? err.message : 'Could not start the microphone.',
        },
      });
      return;
    }
    this.armSleepTimer();
  }

  /** Every captured chunk passes through here, whether or not it is sent on. */
  private handleAudioChunk(chunk: Buffer) {
    if (!this.micEnabled) {
      return;
    }
    // Tara is talking. Everything the microphone hears right now is her, so it
    // must not reach the gate — and must not reach the noise floor either, which
    // is why the gate is reset rather than merely skipped: a floor learned from
    // her own voice would sit far too high for the user's next sentence.
    if (this.outputBusy) {
      if (this.vad.isSpeaking) {
        this.vad.reset();
      }
      // A turn left open here would never be closed by us — the gate swallows the
      // frames that would have produced speechEnd — and would sit waiting on the
      // server's own silence timer instead.
      if (this.streaming) {
        void this.endTurn();
      }
      this.preroll = [];
      this.prerollBytes = 0;

      // Her voice must not reach the gate, or she opens a turn on herself. But the
      // room is still measured, because the user talking over her is the one thing
      // that has to get through a closed gate.
      const level = chunkRms(chunk);
      this.echoChunks += 1;
      if (this.echoChunks <= ChatPanelProvider.BARGE_LEARN_CHUNKS) {
        // Nothing to compare against yet — and there is nothing worth
        // interrupting in the first fraction of a second of a reply anyway.
        this.echoLevel = Math.max(this.echoLevel, level);
        return;
      }
      const threshold = Math.max(
        this.echoLevel * ChatPanelProvider.BARGE_RATIO,
        ChatPanelProvider.BARGE_MIN_LEVEL
      );
      if (level <= threshold) {
        this.bargeRun = 0;
        // Follow the echo down as the voice trails off, so the bar to interrupt
        // falls with it rather than staying at the loudest syllable's height.
        this.echoLevel = this.echoLevel * 0.9 + level * 0.1;
        return;
      }
      this.bargeRun += 1;
      if (this.bargeRun >= ChatPanelProvider.BARGE_CONFIRM_CHUNKS) {
        this.bargeIn();
      }
      return;
    }
    if (this.streaming) {
      this.bytesThisUtterance += chunk.length;
      this.voiceBridge?.sendAudioChunk(chunk.toString('base64'));
    } else {
      this.rememberPreroll(chunk);
    }
    // Pushed last: a speechStart raised inside this call opens the turn, and the
    // preroll it flushes should already contain this chunk.
    this.vad.push(chunk);
  }

  private rememberPreroll(chunk: Buffer) {
    this.preroll.push(chunk);
    this.prerollBytes += chunk.length;
    while (this.prerollBytes > ChatPanelProvider.PREROLL_BYTES && this.preroll.length > 1) {
      this.prerollBytes -= this.preroll.shift()!.length;
    }
  }

  private async onSpeechStart() {
    if (!this.micEnabled || this.streaming) {
      return;
    }
    this.clearTimers();

    const bridge = await this.getOrCreateVoiceBridge();
    if (!bridge) {
      return;
    }

    this.wakeProbe = !this.awake;
    this.streaming = true;
    this.bytesThisUtterance = 0;
    this.postMicState();

    await bridge.startListening();
    if (!this.streaming) {
      // Speech ended while the socket was still coming up.
      return;
    }
    for (const chunk of this.preroll) {
      bridge.sendAudioChunk(chunk.toString('base64'));
    }
    this.preroll = [];
    this.prerollBytes = 0;

    if (this.wakeProbe) {
      // Bound the probe: listening indefinitely to a conversation that is not
      // addressed to us is exactly what sleeping is supposed to prevent.
      this.burstTimer = setTimeout(() => {
        void this.endTurn();
      }, ChatPanelProvider.WAKE_BURST_LIMIT_MS);
    }
  }

  private async onSpeechEnd() {
    if (!this.streaming) {
      return;
    }
    await this.endTurn();
    if (this.micEnabled && this.awake) {
      this.armSleepTimer();
    }
  }

  /** Closes the Gemini turn, if one is open. The transcript arrives afterwards. */
  private async endTurn() {
    if (this.burstTimer) {
      clearTimeout(this.burstTimer);
      this.burstTimer = undefined;
    }
    if (!this.streaming) {
      return;
    }
    this.streaming = false;
    this.voiceBridge?.stopListening();
    this.postMicState();
  }

  private armSleepTimer() {
    this.clearSleepTimer();
    this.sleepTimer = setTimeout(() => {
      this.sleepTimer = undefined;
      if (!this.micEnabled || !this.awake) {
        return;
      }
      this.awake = false;
      this.postMicState();
      // Live is billed per minute of *connection*, not per second of audio sent,
      // so gating the audio while holding the socket open still runs the meter
      // for a room nobody is talking in. The socket closes here and reopens on
      // the next burst of sound — startListening() connects first for exactly
      // this reason, and the preroll buffer covers the handshake, so nothing the
      // user says is lost to it. A pending tool call is the one exception: its id
      // only means something to this session.
      if (this.toolCallByAgent.size === 0) {
        this.voiceBridge?.disconnect();
      }
      this.addSystemMessage('Gone quiet after 15s — say "wake up" to start again.');
    }, ChatPanelProvider.SLEEP_AFTER_MS);
  }

  private clearSleepTimer() {
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = undefined;
    }
  }

  private clearTimers() {
    this.clearSleepTimer();
    if (this.burstTimer) {
      clearTimeout(this.burstTimer);
      this.burstTimer = undefined;
    }
  }

  /**
   * A finished transcript. While asleep it is only ever tested against the wake
   * phrase and then discarded — nothing said to someone else in the room should
   * reach an agent.
   */
  private async handleTranscript(transcript: string) {
    const text = transcript.trim();

    if (this.wakeProbe) {
      this.wakeProbe = false;
      if (ChatPanelProvider.WAKE_PHRASE.test(text)) {
        this.awake = true;
        this.speaker.playChime();
        this.postMicState();
        this.addSystemMessage('Awake — go ahead.');
        this.armSleepTimer();
      }
      return;
    }

    if (!text) {
      return;
    }
    this.postMessage({ type: 'TRANSCRIPT_DONE', payload: { transcript: text } });
    // Recorded only. The model is in the conversation now, and it dispatches to
    // Claude by calling run_coding_task — see handleToolCall. Sending the
    // transcript on from here as well would run every request twice: once
    // because the model asked for it, once because we did.
    this.addEntry('user', text);
  }

  // ── Message handling ───────────────────────────────────────────────────────

  private async handleWebviewMessage(msg: TaraMessage) {
    switch (msg.type) {
      case 'WEBVIEW_READY': {
        // A postMessage sent before the webview's script has subscribed is
        // dropped, so the webview asks for its state once it is listening.
        await this.postInit();
        break;
      }

      case 'LIST_SESSIONS': {
        this.postSessions();
        break;
      }

      case 'NEW_SESSION': {
        this.store.createSession();
        this.history = [];
        // Any agent still running belongs to the session being left; its output
        // would otherwise land in the new one as if it had been asked there.
        this.orchestrator.stopAll();
        await this.postInit();
        this.postSessions();
        break;
      }

      case 'OPEN_SESSION': {
        const { id } = msg.payload as { id?: string };
        const entries = id ? this.store.openSession(id) : undefined;
        if (!entries) {
          break;
        }
        this.history = entries.slice();
        this.orchestrator.stopAll();
        await this.postInit();
        this.postSessions();
        break;
      }

      case 'RENAME_SESSION': {
        const { id, title } = msg.payload as { id?: string; title?: string };
        if (id && typeof title === 'string') {
          this.store.renameSession(id, title);
          this.postSessions();
        }
        break;
      }

      case 'DELETE_SESSION': {
        const { id } = msg.payload as { id?: string };
        if (!id) {
          break;
        }
        const wasActive = id === this.store.activeId;
        this.store.deleteSession(id);
        if (wasActive) {
          // deleteSession always leaves one active, so this is never empty by
          // accident — the panel is never left with no session at all.
          this.history = this.store.entriesForActive().slice();
          this.orchestrator.stopAll();
          await this.postInit();
        }
        this.postSessions();
        break;
      }

      case 'SET_MIC_ENABLED': {
        const { enabled } = msg.payload as { enabled?: boolean };
        await this.setMicEnabled(!!enabled);
        break;
      }

      case 'SEND_COMMAND': {
        const { text } = msg.payload as { text: string };
        await this.submitUserText(text);
        break;
      }

      case 'REPLY_TO_AGENT': {
        const { text, agentId } = msg.payload as { text: string; agentId?: string };
        this.addEntry('user', text);
        // A reply goes straight into a live session, so it needs the same
        // destructive-command gate as a fresh task — otherwise "yes, drop the
        // table" reaches the agent unchecked.
        if (this.shouldConfirm(text)) {
          this.requestConfirmation(text, agentId);
          break;
        }
        await this.forwardReply(text, agentId);
        break;
      }

      case 'OPEN_SETTINGS': {
        void vscode.commands.executeCommand(
          'workbench.action.openSettings',
          '@ext:tara.tara-vscode'
        );
        break;
      }

      case 'CHECK_SETUP': {
        await this.runSetupCheck();
        break;
      }

      case 'SAVE_API_KEY': {
        const { key } = msg.payload as { key: string };
        await this.saveApiKeyIfValid(key);
        break;
      }

      case 'SETUP_COMPLETE': {
        await this.context.globalState.update(STATE_SETUP_COMPLETE, true);
        break;
      }

      case 'SET_MIC_DEVICE': {
        const { deviceId } = msg.payload as { deviceId?: string };
        await this.context.globalState.update(STATE_MIC_DEVICE, deviceId ?? '');
        break;
      }

      case 'SET_SPEAKER_DEVICE': {
        const { deviceId } = msg.payload as { deviceId?: string };
        await this.context.globalState.update(STATE_SPEAKER_DEVICE, deviceId ?? '');
        this.speaker.setDevice(deviceId ?? '');
        break;
      }

      case 'SET_VOICE': {
        const { voiceName } = msg.payload as { voiceName?: string };
        await this.updateVoiceSetting('voiceName', voiceName);
        break;
      }

      case 'SET_LIVE_MODEL': {
        const { model } = msg.payload as { model?: string };
        await this.updateVoiceSetting('geminiLiveModel', model);
        break;
      }

      case 'SET_LANGUAGE': {
        const { language } = msg.payload as { language?: string };
        await this.updateVoiceSetting('language', language);
        break;
      }

      case 'SET_SPEAK_RESPONSES': {
        const { enabled } = msg.payload as { enabled?: boolean };
        await this.updateVoiceSetting('speakResponses', !!enabled);
        break;
      }

      case 'OPEN_URL': {
        const { url } = msg.payload as { url: string };
        // Only follow links we generated — never an arbitrary string from the webview.
        if (
          /^https:\/\/(aistudio\.google\.com|ai\.google\.dev|docs\.anthropic\.com)\//.test(url)
        ) {
          void vscode.env.openExternal(vscode.Uri.parse(url));
        }
        break;
      }

      case 'INSTALL_FFMPEG': {
        // Typed into a terminal but deliberately not executed: this installs
        // software, so the user gets to read it and press Enter themselves.
        const terminal = vscode.window.createTerminal('Tara — install ffmpeg');
        terminal.show();
        terminal.sendText(ffmpegInstallCommand(), false);
        break;
      }

      case 'STOP_AGENT': {
        const { agentId } = msg.payload as { agentId?: string };
        if (agentId) {
          this.orchestrator.stopAgent(agentId);
        } else {
          this.orchestrator.stopAll();
        }
        break;
      }

      case 'CONFIRM_EXECUTION': {
        const pending = this.pendingConfirmation;
        this.pendingConfirmation = undefined;
        if (!pending) {
          break;
        }
        if (pending.replyToAgentId !== undefined) {
          await this.forwardReply(pending.prompt, pending.replyToAgentId || undefined);
        } else {
          this.dispatchToOrchestrator(pending.prompt);
        }
        break;
      }

      case 'CANCEL_EXECUTION': {
        this.pendingConfirmation = undefined;
        this.addSystemMessage('Command cancelled.');
        break;
      }

      default:
        break;
    }
  }

  /**
   * A single entry point for text from either input path. If an agent is blocked
   * on a question, the text answers it rather than starting a competing task.
   */
  private async submitUserText(text: string) {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    this.addEntry('user', trimmed);

    if (this.orchestrator.hasAgentAwaitingInput()) {
      const answered = this.orchestrator.replyToAgent(trimmed);
      if (answered) {
        return;
      }
    }
    await this.executeCommand(trimmed);
  }

  private addEntry(role: ChatEntry['role'], content: string) {
    const entry: ChatEntry = {
      id: `${role}-${Date.now()}-${this.history.length}`,
      role,
      content,
      timestamp: Date.now(),
    };
    this.history.push(entry);
    if (this.history.length > MAX_HISTORY_ENTRIES) {
      this.history.splice(0, this.history.length - MAX_HISTORY_ENTRIES);
    }
    // Persisted per project, so reopening the folder — even after reinstalling
    // the extension — shows the conversation that was happening in it.
    this.store.append(entry);

    // Only `user` is echoed. This used to post nothing at all, which is why a
    // dictated command never appeared on screen: typed input showed up solely
    // because the webview drew its own optimistic copy, and a transcript has no
    // such local origin. Claude and system entries already reach the webview via
    // AGENT_OUTPUT, so echoing those here would render them twice.
    if (role === 'user') {
      this.postMessage({ type: 'USER_MESSAGE', payload: { entry } });
    }
  }

  private addSystemMessage(text: string) {
    this.addEntry('system', text);
    this.postMessage({ type: 'AGENT_OUTPUT', payload: { type: 'system', text } });
  }

  private handleAgentOutput(agentId: string, data: AgentOutput) {
    // Only the final result is recorded. `text` arrives as streaming fragments,
    // which the webview renders live from AGENT_OUTPUT; storing each fragment as
    // its own entry filled the history — and now the history file — with dozens
    // of partial duplicates of the same answer.
    if (data.type === 'result') {
      this.addEntry('claude', data.text);
    } else if (data.type === 'error') {
      this.addEntry('system', `✕ ${data.text}`);
    }
    this.postMessage({ type: 'AGENT_OUTPUT', payload: { agentId, ...data } });

    // Only a terminal outcome is announced. `text` events stream in fragments, so
    // announcing those would talk over itself; this is the one line the user is
    // actually waiting to hear. An error is announced too — silence after a
    // failed task is indistinguishable from a task still running.
    if ((data.type === 'result' || data.type === 'error') && data.text.trim()) {
      this.deliverAgentResult(agentId, data.text, data.type === 'error');
    }
  }

  // ── Setup check ────────────────────────────────────────────────────────────

  private async runSetupCheck() {
    const config = vscode.workspace.getConfiguration('tara');
    const storedKey = await this.getApiKey();
    const claudePath = config.get<string>('claudeCodePath') || 'claude';

    // A key is only "set up" once it has been proven to work. Keys written by
    // an earlier build, or migrated out of the plaintext setting, arrive
    // unverified — check those once here rather than trusting them.
    let geminiKey = false;
    if (storedKey) {
      if (this.context.globalState.get<boolean>(STATE_KEY_VERIFIED, false)) {
        geminiKey = true;
      } else {
        const result = await verifyGeminiKey(storedKey, this.liveModel());
        if (result.ok) {
          geminiKey = true;
          await this.context.globalState.update(STATE_KEY_VERIFIED, true);
          this.apiKeyModelWarning = result.modelWarning ?? '';
        } else if (result.reachable) {
          // The service answered and refused it, so the stored key is no good.
          // It stays in storage — deleting what the user pasted, unasked, would
          // be worse than telling them it does not work.
          this.apiKeyError = result.message ?? 'The stored key is no longer valid.';
        } else {
          // Offline. There is no evidence against this key, and blocking the
          // gate here would also block text commands, which never touch Gemini.
          // So accept it provisionally and re-check when the network is back;
          // the verified flag stays false, so this is not a permanent pass.
          geminiKey = true;
          this.apiKeyModelWarning =
            result.message ?? 'Could not reach Google to re-check the stored key.';
        }
      }
    }

    const status: SetupStatus = {
      geminiKey,
      apiKeyError: this.apiKeyError || undefined,
      apiKeyModelWarning: this.apiKeyModelWarning || undefined,
      claudeInstalled: false,
      claudeAuthed: false,
      bundledCaptureOk: false,
      ffmpegInstalled: false,
      ffmpegInstallCommand: ffmpegInstallCommand(),
      micDevices: [],
      micDeviceId: '',
      speakerDevices: [],
      speakerDeviceId: '',
      voiceName: config.get<string>('voiceName') || 'Aoede',
      voiceOptions: PREBUILT_VOICES,
      liveModel: this.liveModel(),
      liveModelOptions: [],
      language: config.get<string>('language') || 'auto',
      languageOptions: SPOKEN_LANGUAGES,
      speakResponses: config.get<boolean>('speakResponses', true),
    };

    // Only ask for the model list once the key has earned it; an unverified key
    // would just produce a 400 here.
    if (geminiKey && storedKey) {
      status.liveModelOptions = await listLiveModels(storedKey);
    }

    const capture = await probeCapture(this.ffmpegPath());
    status.captureBackend = capture.backend;
    status.bundledCaptureOk = capture.bundledOk;
    status.bundledCaptureError = capture.bundledError;
    status.bundledCaptureVersion = capture.bundledVersion;
    status.ffmpegInstalled = capture.ffmpeg.ok;
    status.ffmpegVersion = capture.ffmpeg.version;
    status.ffmpegError = capture.ffmpeg.error;

    // Output devices come from the bundled module only; there is no ffmpeg
    // fallback for playback because the webview's PcmPlayer already is one.
    const speakers = probeSpeakers();
    status.speakerDevices = speakers.devices;
    status.speakerError = speakers.ok ? undefined : speakers.error;
    if (speakers.ok) {
      const storedSpeaker = this.context.globalState.get<string>(STATE_SPEAKER_DEVICE, '');
      const resolved = speakers.devices.some((d) => d.id === storedSpeaker)
        ? storedSpeaker
        : (speakers.devices.find((d) => d.isDefault) ?? speakers.devices[0]).id;
      status.speakerDeviceId = resolved;
      if (resolved !== storedSpeaker) {
        await this.context.globalState.update(STATE_SPEAKER_DEVICE, resolved);
      }
      this.speaker.setDevice(resolved);
    }

    this.micDevices = capture.devices;
    status.micDevices = capture.devices;
    if (capture.devices.length) {
      const resolved = await this.resolveMicDevice();
      status.micDeviceId = resolved ?? '';
      // Persist the fallback so the picker and the next capture agree.
      const stored = this.context.globalState.get<string>(STATE_MIC_DEVICE, '');
      if (resolved && resolved !== stored) {
        await this.context.globalState.update(STATE_MIC_DEVICE, resolved);
      }
    }

    const version = await runClaude(claudePath, ['--version']);
    if (!version.ok) {
      this.postMessage({ type: 'SETUP_STATUS', payload: status });
      return;
    }
    status.claudeInstalled = true;
    status.claudeVersion = version.stdout.trim();

    // `claude auth status` prints JSON, e.g.
    //   {"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}
    // The previous implementation searched for the substring "logged in", which
    // never matches `loggedIn`, so a signed-in user was reported as signed out —
    // and the setup gate could never be satisfied.
    const auth = await runClaude(claudePath, ['auth', 'status']);
    const parsed = parseJsonLoose(auth.stdout) ?? parseJsonLoose(auth.stderr);
    if (parsed && typeof parsed.loggedIn === 'boolean') {
      status.claudeAuthed = parsed.loggedIn;
      const method = typeof parsed.authMethod === 'string' ? parsed.authMethod : '';
      const tier = typeof parsed.subscriptionType === 'string' ? parsed.subscriptionType : '';
      status.claudeAuthDetail = [method, tier].filter(Boolean).join(' · ');
    } else {
      // Older CLIs print prose. Fall back to a conservative text check.
      const blob = `${auth.stdout}\n${auth.stderr}`.toLowerCase();
      status.claudeAuthed =
        auth.ok && /\b(logged in|authenticated|active subscription)\b/.test(blob);
    }

    this.postMessage({ type: 'SETUP_STATUS', payload: status });
  }

  // ── Execution ──────────────────────────────────────────────────────────────

  private shouldConfirm(text: string): boolean {
    return (
      vscode.workspace.getConfiguration('tara').get<boolean>('riskConfirmation', true) &&
      isRiskyCommand(text)
    );
  }

  /**
   * Asks the user to confirm. `replyToAgentId` distinguishes "confirm this new
   * task" from "confirm this answer to a waiting agent".
   */
  private requestConfirmation(prompt: string, replyToAgentId?: string) {
    if (this.pendingConfirmation) {
      // One dialog at a time; queueing silently would hide the second command.
      this.addSystemMessage(
        'Another command is already waiting for confirmation — answer that one first.'
      );
      return;
    }
    this.pendingConfirmation =
      replyToAgentId !== undefined
        ? { prompt, replyToAgentId: replyToAgentId || '' }
        : { prompt };
    this.postMessage({
      type: 'RISK_CONFIRM_REQUEST',
      payload: { message: `This looks destructive:\n\n"${prompt}"\n\nRun it anyway?` },
    });
    void this.speak('That command looks destructive. Please confirm before I run it.');
  }

  private async forwardReply(text: string, agentId?: string) {
    const answered = this.orchestrator.replyToAgent(text, agentId);
    if (!answered) {
      this.addSystemMessage(
        'That agent is no longer waiting — sending it as a new task instead.'
      );
      await this.executeCommand(text);
    }
  }

  private async executeCommand(prompt: string) {
    if (this.shouldConfirm(prompt)) {
      this.requestConfirmation(prompt);
      return;
    }
    this.dispatchToOrchestrator(prompt);
  }

  private dispatchToOrchestrator(prompt: string) {
    try {
      this.orchestrator.runTask(prompt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // addSystemMessage already posts AGENT_OUTPUT to the webview; posting
      // ERROR as well rendered the same failure twice.
      this.addSystemMessage(`Error: ${message}`);
    }
  }

  postMessage(msg: TaraMessage) {
    void this.view?.webview.postMessage(msg);
  }

  dispose() {
    // First: a closing window should not lose the last debounced write.
    this.store.dispose();
    this.clearTimers();
    this.disposeViewListeners();
    // Before the bridge, so no chunk is emitted at a disposed listener — and so
    // the devices are released even if the bridge teardown throws.
    this.recorder.dispose();
    this.speaker.dispose();
    this.voiceBridge?.dispose();
    this.voiceBridge = undefined;
  }

  // ── HTML ───────────────────────────────────────────────────────────────────

  private buildHtml(webview: vscode.Webview): string {
    const distPath = vscode.Uri.joinPath(this.context.extensionUri, 'webview-ui', 'dist');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(distPath, 'assets', 'index.js')
    );
    const cssUri = findCssUri(webview, distPath);
    // Avatars are bundled rather than hotlinked: the CSP allows `img-src` only
    // from cspSource and data:, so a remote URL would simply be blocked — and
    // Vite copies `public/` through un-hashed, so these names stay stable.
    const avatars = {
      me: webview.asWebviewUri(vscode.Uri.joinPath(distPath, 'avatar-me.png')).toString(),
      claude: webview
        .asWebviewUri(vscode.Uri.joinPath(distPath, 'avatar-claude.png'))
        .toString(),
    };
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src ${webview.cspSource} 'unsafe-inline';
    script-src 'nonce-${nonce}' ${webview.cspSource};
    img-src ${webview.cspSource} data:;
    media-src ${webview.cspSource} blob:;
    font-src ${webview.cspSource};
    connect-src ${webview.cspSource};
  "/>
  ${cssUri ? `<link rel="stylesheet" href="${cssUri}" />` : ''}
  <title>Tara</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.__taraAvatars = ${JSON.stringify(avatars)};</script>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Runs the Claude CLI and captures its output.
 *
 * Goes through buildLaunchSpec because on Windows `claude` is a `.cmd` shim, and
 * handing that straight to execFile with `shell: false` fails with EINVAL on
 * Node 20+ — which would make the setup check report "not installed" on every
 * Windows machine. Async so the extension host is never blocked; the previous
 * implementation used execSync.
 */
function runClaude(claudePath: string, args: string[]): Promise<CommandResult> {
  const launch = buildLaunchSpec(claudePath, args);
  if (!launch) {
    return Promise.resolve({ ok: false, stdout: '', stderr: 'claude not found on PATH' });
  }
  return new Promise((resolve) => {
    // execFile can throw synchronously (bad path, EINVAL). Left uncaught it
    // becomes a rejection that never resolves the setup check.
    try {
      execFile(
        launch.file,
        launch.args,
        {
          timeout: 10_000,
          windowsHide: true,
          shell: false,
          windowsVerbatimArguments: launch.windowsVerbatimArguments,
          encoding: 'utf-8',
        },
        (error, stdout, stderr) => {
          resolve({ ok: !error, stdout: stdout ?? '', stderr: stderr ?? '' });
        }
      );
    } catch (err) {
      resolve({
        ok: false,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/** Finds the first `{...}` in `text` and parses it, tolerating surrounding noise. */
function parseJsonLoose(text: string): Record<string, unknown> | undefined {
  if (!text) {
    return undefined;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function findCssUri(
  webview: vscode.Webview,
  distPath: vscode.Uri
): string | undefined {
  try {
    const assetsPath = path.join(distPath.fsPath, 'assets');
    const cssFile = fs.readdirSync(assetsPath).find((f) => f.endsWith('.css'));
    if (cssFile) {
      return webview
        .asWebviewUri(vscode.Uri.joinPath(distPath, 'assets', cssFile))
        .toString();
    }
  } catch {
    // dist not built yet
  }
  return undefined;
}

export function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
