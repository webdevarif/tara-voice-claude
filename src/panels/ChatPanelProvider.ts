import * as vscode from 'vscode';
import { AgentOrchestrator } from '../execution/AgentOrchestrator';
import { GeminiVoiceBridge } from '../voice/GeminiVoiceBridge';
import { TaraMessage, ChatEntry, isRiskyCommand } from '../types';
import * as fs from 'fs';
import * as path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// ChatPanelProvider — Webview panel for the Tara chat UI
// ─────────────────────────────────────────────────────────────────────────────
export class ChatPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private voiceBridge?: GeminiVoiceBridge;
  private history: ChatEntry[] = [];
  private context: vscode.ExtensionContext;
  private orchestrator: AgentOrchestrator;
  private pendingConfirmation?: { prompt: string; agentId?: string };

  constructor(context: vscode.ExtensionContext, orchestrator: AgentOrchestrator) {
    this.context = context;
    this.orchestrator = orchestrator;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        vscode.Uri.joinPath(this.context.extensionUri, 'webview-ui', 'dist'),
        vscode.Uri.joinPath(this.context.extensionUri, 'webview-ui'),
      ],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(
      (msg: TaraMessage) => this.handleWebviewMessage(msg),
      null,
      this.context.subscriptions
    );

    // Focus context key
    webviewView.onDidChangeVisibility(() => {
      vscode.commands.executeCommand(
        'setContext',
        'tara.chatViewFocused',
        webviewView.visible
      );
    });

    // Settings button in panel toolbar
    webviewView.title = 'Chat';
    webviewView.description = '';

    // Send initial state
    this.postMessage({ type: 'INIT', payload: { history: this.history } });

    // Set up orchestrator output → chat panel
    this.orchestrator.onOutput((agentId, data) => {
      const entry: ChatEntry = {
        id: `${agentId}-${Date.now()}`,
        role: 'claude',
        content: data.text,
        timestamp: Date.now(),
      };
      this.history.push(entry);
      this.postMessage({ type: 'AGENT_OUTPUT', payload: { agentId, ...data } });
    });
  }

  // ── Voice ──────────────────────────────────────────────────────────────────

  triggerVoiceStart() {
    this.postMessage({ type: 'AGENT_STATUS', payload: { action: 'triggerVoice' } });
  }

  private async getOrCreateVoiceBridge(): Promise<GeminiVoiceBridge | null> {
    if (this.voiceBridge) {
      return this.voiceBridge;
    }

    const apiKey = vscode.workspace
      .getConfiguration('tara')
      .get<string>('geminiApiKey', '');

    if (!apiKey) {
      const action = await vscode.window.showErrorMessage(
        'Tara: Gemini API key not set. Please configure it in settings.',
        'Open Settings'
      );
      if (action === 'Open Settings') {
        vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'tara.geminiApiKey'
        );
      }
      return null;
    }

    this.voiceBridge = new GeminiVoiceBridge(apiKey);

    this.voiceBridge.on('transcriptToken', (token: string) => {
      this.postMessage({ type: 'TRANSCRIPT_TOKEN', payload: { token } });
    });

    this.voiceBridge.on('transcriptDone', (transcript: string) => {
      this.postMessage({ type: 'TRANSCRIPT_DONE', payload: { transcript } });
      // Auto-execute the transcript as a command
      this.executeCommand(transcript);
    });

    this.voiceBridge.on('ttsChunk', (base64: string) => {
      this.postMessage({ type: 'TTS_AUDIO_CHUNK', payload: { base64 } });
    });

    this.voiceBridge.on('ttsDone', () => {
      this.postMessage({ type: 'TTS_DONE', payload: {} });
    });

    this.voiceBridge.on('error', (msg: string) => {
      this.postMessage({ type: 'ERROR', payload: { message: msg } });
    });

    await this.voiceBridge.connect();
    return this.voiceBridge;
  }

  // ── Message handling ───────────────────────────────────────────────────────

  private async handleWebviewMessage(msg: TaraMessage) {
    switch (msg.type) {
      case 'VOICE_START': {
        const bridge = await this.getOrCreateVoiceBridge();
        bridge?.startListening();
        break;
      }

      case 'VOICE_STOP': {
        this.voiceBridge?.stopListening();
        break;
      }

      case 'VOICE_AUDIO_CHUNK': {
        const { base64 } = msg.payload as { base64: string };
        this.voiceBridge?.receiveAudioChunk(base64);
        break;
      }

      case 'SEND_COMMAND': {
        const { text } = msg.payload as { text: string };
        this.addUserMessage(text);
        await this.executeCommand(text);
        break;
      }

      case 'OPEN_SETTINGS': {
        vscode.commands.executeCommand(
          'workbench.action.openSettings',
          '@ext:tara.tara-vscode'
        );
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
        if (this.pendingConfirmation) {
          const { prompt } = this.pendingConfirmation;
          this.pendingConfirmation = undefined;
          await this.dispatchToOrchestrator(prompt);
        }
        break;
      }

      case 'CANCEL_EXECUTION': {
        this.pendingConfirmation = undefined;
        this.addSystemMessage('Command cancelled.');
        break;
      }
    }
  }

  private addUserMessage(text: string) {
    const entry: ChatEntry = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    this.history.push(entry);
  }

  private addSystemMessage(text: string) {
    const entry: ChatEntry = {
      id: `sys-${Date.now()}`,
      role: 'system',
      content: text,
      timestamp: Date.now(),
    };
    this.history.push(entry);
    this.postMessage({ type: 'AGENT_OUTPUT', payload: { type: 'system', text } });
  }

  private async executeCommand(prompt: string) {
    const riskCheck = vscode.workspace
      .getConfiguration('tara')
      .get<boolean>('riskConfirmation', true);

    if (riskCheck && isRiskyCommand(prompt)) {
      this.pendingConfirmation = { prompt };
      this.postMessage({
        type: 'RISK_CONFIRM_REQUEST',
        payload: {
          message: `⚠️ This command may be destructive:\n\n"${prompt}"\n\nConfirm execution?`,
        },
      });
      // Also speak the warning
      this.voiceBridge?.speak(
        `Warning: this command appears destructive. Please confirm before I proceed.`
      );
      return;
    }

    await this.dispatchToOrchestrator(prompt);
  }

  private async dispatchToOrchestrator(prompt: string) {
    try {
      await this.orchestrator.runTask(prompt);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.addSystemMessage(`Error: ${message}`);
      this.postMessage({ type: 'ERROR', payload: { message } });
    }
  }

  postMessage(msg: TaraMessage) {
    this.view?.webview.postMessage(msg);
  }

  // ── HTML ───────────────────────────────────────────────────────────────────

  private buildHtml(webview: vscode.Webview): string {
    const distPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      'webview-ui',
      'dist'
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(distPath, 'assets', 'index.js')
    );
    // Find the actual CSS file (Vite may name it differently)
    const cssUri = this.findCssUri(webview, distPath);
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
    connect-src wss: https:;
    media-src 'self' blob:;
    font-src ${webview.cspSource} https://fonts.gstatic.com;
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

  private findCssUri(webview: vscode.Webview, distPath: vscode.Uri): string | null {
    try {
      const assetsPath = path.join(distPath.fsPath, 'assets');
      const files = fs.readdirSync(assetsPath);
      const cssFile = files.find((f) => f.endsWith('.css'));
      if (cssFile) {
        return webview.asWebviewUri(
          vscode.Uri.joinPath(distPath, 'assets', cssFile)
        ).toString();
      }
    } catch {
      // dist not built yet
    }
    return null;
  }
}

function getNonce(): string {
  let text = '';
  const possible =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
