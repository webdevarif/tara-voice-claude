import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import {
  AgentOrchestrator,
  AgentOutput,
  buildLaunchSpec,
} from '../execution/AgentOrchestrator';
import { GeminiVoiceBridge, VoiceState } from '../voice/GeminiVoiceBridge';
import {
  AudioInputDevice,
  CaptureBackend,
  MicRecorder,
  ffmpegInstallCommand,
  probeCapture,
} from '../voice/MicRecorder';
import { verifyGeminiKey } from '../voice/GeminiKeyCheck';
import {
  AudioOutputDevice,
  SpeakerPlayer,
  probeSpeakers,
} from '../voice/SpeakerPlayer';
import {
  LiveModelOption,
  PREBUILT_VOICES,
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
  /**
   * Set when VOICE_STOP arrives while VOICE_START is still awaiting the bridge.
   * Without it, the stop hits an undefined bridge and is lost, leaving the
   * session listening forever and never finalizing the utterance.
   */
  private voiceStopPending = false;
  /** Microphone capture, in this process rather than the webview. */
  private readonly recorder = new MicRecorder();
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
    // ffmpeg's stdout is already 16 kHz s16le mono — the exact wire format —
    // so this is a base64 wrap and nothing more.
    this.recorder.on('data', (chunk: Buffer) => {
      this.bytesThisUtterance += chunk.length;
      this.voiceBridge?.sendAudioChunk(chunk.toString('base64'));
    });
    // Opening a dshow graph takes ~450 ms, so "listening" is only true once the
    // first sample actually lands. Claiming it earlier trains users to start
    // talking into a device that is not open yet.
    this.recorder.on('capturing', () => {
      this.postMessage({ type: 'VOICE_STATE', payload: { mic: 'capturing' } });
    });
    this.recorder.on('error', (message: string) => {
      this.postMessage({ type: 'VOICE_STATE', payload: { mic: 'idle' } });
      this.postMessage({ type: 'ERROR', payload: { message } });
    });

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

  private async postInit() {
    this.postMessage({
      type: 'INIT',
      payload: {
        history: this.history,
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
    key: 'voiceName' | 'geminiLiveModel' | 'speakResponses',
    value: string | boolean | undefined
  ) {
    if (value === undefined || value === '') {
      return;
    }
    await vscode.workspace
      .getConfiguration('tara')
      .update(key, value, vscode.ConfigurationTarget.Global);
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
      vscode.workspace.getConfiguration('tara').get<string>('voiceMode', 'push-to-talk') ===
      'disabled'
    );
  }

  triggerVoiceStart() {
    if (this.voiceDisabled()) {
      void vscode.window.showInformationMessage(
        'Tara: voice input is disabled. Set "tara.voiceMode" to "push-to-talk" to enable it.'
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
      this.postMessage({ type: 'TRANSCRIPT_DONE', payload: { transcript } });
      void this.submitUserText(transcript);
    });
    bridge.on('ttsChunk', (base64: string) => {
      // Played here when the bundled output module is available, so the user can
      // choose a named device. The webview's PcmPlayer is the fallback for
      // platforms without a prebuilt binary.
      if (this.speaker.available) {
        this.speaker.enqueue(Buffer.from(base64, 'base64'));
      } else {
        this.postMessage({ type: 'TTS_AUDIO_CHUNK', payload: { base64 } });
      }
    });
    bridge.on('ttsDone', () => {
      this.postMessage({ type: 'TTS_DONE', payload: {} });
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

  private async startCapture() {
    this.voiceStopPending = false;
    this.bytesThisUtterance = 0;
    this.postMessage({ type: 'VOICE_STATE', payload: { mic: 'opening' } });

    const deviceId = await this.resolveMicDevice();
    if (!deviceId) {
      this.postMessage({ type: 'VOICE_STATE', payload: { mic: 'idle' } });
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

    const bridge = await this.getOrCreateVoiceBridge();
    if (!bridge) {
      this.postMessage({ type: 'VOICE_STATE', payload: { mic: 'idle' } });
      return;
    }

    // Arming the turn and opening the device are independent, and the device is
    // the slow one (~450 ms). Serialising them would add the socket round-trip
    // on top of that for no reason; chunks that beat the socket open are
    // buffered by the bridge.
    try {
      await Promise.all([bridge.startListening(), this.recorder.start(this.ffmpegPath(), deviceId)]);
    } catch (err) {
      this.postMessage({ type: 'VOICE_STATE', payload: { mic: 'idle' } });
      this.postMessage({
        type: 'ERROR',
        payload: {
          message: err instanceof Error ? err.message : 'Could not start the microphone.',
        },
      });
      await this.recorder.stop();
      return;
    }

    // The release can land while the device is still opening.
    if (this.voiceStopPending) {
      this.voiceStopPending = false;
      await this.stopCapture();
    }
  }

  private async stopCapture() {
    if (!this.recorder.active && !this.voiceBridge) {
      // Nothing is running yet — remember the release so startCapture honours it.
      this.voiceStopPending = true;
      return;
    }

    // Read before stopping: stop() clears it.
    const backend = this.recorder.activeBackend;
    // Stop the device first and wait for it to exit, so `audioStreamEnd` cannot
    // race ahead of the last chunks and truncate the utterance server-side.
    await this.recorder.stop();
    this.postMessage({ type: 'VOICE_STATE', payload: { mic: 'idle' } });
    this.voiceBridge?.stopListening();

    if (this.bytesThisUtterance === 0) {
      // Released before the device delivered anything. The bundled backend opens
      // in ~60 ms so this is a genuinely instant tap; ffmpeg needs ~450 ms, which
      // is easy to beat by accident, so the advice differs.
      this.addSystemMessage(
        backend === 'ffmpeg'
          ? 'No audio was captured — this backend takes about half a second to open the microphone. Hold the button until the indicator says "Listening", then speak.'
          : 'No audio was captured — the button was released before the microphone delivered anything. Hold it while you speak.'
      );
    }
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

      case 'VOICE_START': {
        if (this.voiceDisabled()) {
          this.addSystemMessage('Voice input is disabled — set "tara.voiceMode" to enable it.');
          break;
        }
        await this.startCapture();
        break;
      }

      case 'VOICE_STOP': {
        await this.stopCapture();
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
    this.history.push({
      id: `${role}-${Date.now()}-${this.history.length}`,
      role,
      content,
      timestamp: Date.now(),
    });
    if (this.history.length > MAX_HISTORY_ENTRIES) {
      this.history.splice(0, this.history.length - MAX_HISTORY_ENTRIES);
    }
  }

  private addSystemMessage(text: string) {
    this.addEntry('system', text);
    this.postMessage({ type: 'AGENT_OUTPUT', payload: { type: 'system', text } });
  }

  private handleAgentOutput(agentId: string, data: AgentOutput) {
    if (data.type === 'text' || data.type === 'result') {
      this.addEntry('claude', data.text);
    } else if (data.type === 'error') {
      this.addEntry('system', `✕ ${data.text}`);
    }
    this.postMessage({ type: 'AGENT_OUTPUT', payload: { agentId, ...data } });

    // Only the final result is spoken. `text` events stream in fragments, so
    // speaking those would talk over itself; and this is the one line the user
    // is actually waiting to hear. Questions and warnings speak elsewhere.
    if (data.type === 'result' && data.text.trim()) {
      void this.speak(data.text);
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
