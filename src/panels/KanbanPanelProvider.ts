import * as vscode from 'vscode';
import { AgentOrchestrator } from '../execution/AgentOrchestrator';
import { TaraMessage, KanbanBoard } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// KanbanPanelProvider — sidebar panel showing agent task board + cost tracker
// ─────────────────────────────────────────────────────────────────────────────
export class KanbanPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private context: vscode.ExtensionContext;
  private orchestrator: AgentOrchestrator;

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
      ],
    };

    webviewView.webview.html = this.getKanbanHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (msg: TaraMessage) => this.handleMessage(msg),
      null,
      this.context.subscriptions
    );

    // Send current board state on load
    this.postKanbanUpdate(this.orchestrator.getBoard());
  }

  postKanbanUpdate(board: KanbanBoard) {
    this.view?.webview.postMessage({ type: 'KANBAN_UPDATE', payload: board });
  }

  private handleMessage(msg: TaraMessage) {
    if (msg.type === 'STOP_AGENT') {
      const { agentId } = msg.payload as { agentId: string };
      this.orchestrator.stopAgent(agentId);
    }
  }

  private getKanbanHtml(webview: vscode.Webview): string {
    const distPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      'webview-ui',
      'dist'
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(distPath, 'assets', 'kanban.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(distPath, 'assets', 'index.css')
    );
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src ${webview.cspSource} 'unsafe-inline';
    script-src 'nonce-${nonce}';
    font-src ${webview.cspSource} https://fonts.gstatic.com;
  "/>
  <link rel="stylesheet" href="${styleUri}" />
  <title>Tara Kanban</title>
</head>
<body>
  <div id="kanban-root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
