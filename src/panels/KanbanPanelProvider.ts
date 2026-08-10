import * as vscode from 'vscode';
import { AgentOrchestrator } from '../execution/AgentOrchestrator';
import { KanbanBoard, TaraMessage } from '../types';
import { findCssUri, getNonce } from './ChatPanelProvider';

// ─────────────────────────────────────────────────────────────────────────────
// KanbanPanelProvider — sidebar board of agent cards plus the cost header
// ─────────────────────────────────────────────────────────────────────────────
export class KanbanPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly orchestrator: AgentOrchestrator
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        vscode.Uri.joinPath(this.context.extensionUri, 'webview-ui', 'dist'),
      ],
    };

    webviewView.webview.html = this.getKanbanHtml(webviewView.webview);

    // Scoped per view instance so a recreated view does not stack handlers.
    this.dispose();
    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((msg: TaraMessage) => this.handleMessage(msg)),
      webviewView.onDidDispose(() => {
        this.dispose();
        this.view = undefined;
      })
    );

    this.postKanbanUpdate(this.orchestrator.getBoard());
  }

  postKanbanUpdate(board: KanbanBoard) {
    void this.view?.webview.postMessage({ type: 'KANBAN_UPDATE', payload: board });
  }

  private handleMessage(msg: TaraMessage) {
    if (msg.type === 'WEBVIEW_READY') {
      // The eager post in resolveWebviewView can land before the webview's
      // script subscribes, so the board is re-sent on request.
      this.postKanbanUpdate(this.orchestrator.getBoard());
      return;
    }
    if (msg.type === 'STOP_AGENT') {
      const { agentId } = msg.payload as { agentId?: string };
      if (agentId) {
        this.orchestrator.stopAgent(agentId);
      } else {
        this.orchestrator.stopAll();
      }
    }
  }

  dispose() {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  private getKanbanHtml(webview: vscode.Webview): string {
    const distPath = vscode.Uri.joinPath(this.context.extensionUri, 'webview-ui', 'dist');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(distPath, 'assets', 'kanban.js')
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
    font-src ${webview.cspSource};
  "/>
  ${cssUri ? `<link rel="stylesheet" href="${cssUri}" />` : ''}
  <title>Tara Kanban</title>
</head>
<body>
  <div id="kanban-root"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
