import * as vscode from 'vscode';
import { ChatPanelProvider } from './panels/ChatPanelProvider';
import { KanbanPanelProvider } from './panels/KanbanPanelProvider';
import { AgentOrchestrator } from './execution/AgentOrchestrator';

let orchestrator: AgentOrchestrator | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('[Tara] Extension activating...');

  // ── Orchestrator (manages Claude Code processes) ──────────────────────────
  orchestrator = new AgentOrchestrator(context);

  // ── Panel Providers ───────────────────────────────────────────────────────
  const chatProvider = new ChatPanelProvider(context, orchestrator);
  const kanbanProvider = new KanbanPanelProvider(context, orchestrator);

  // Wire kanban updates from orchestrator to kanban panel
  orchestrator.onKanbanUpdate((board) => {
    kanbanProvider.postKanbanUpdate(board);
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('tara.chatView', chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider('tara.kanbanView', kanbanProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // ── Commands ──────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('tara.openChat', () => {
      vscode.commands.executeCommand('tara.chatView.focus');
    }),

    vscode.commands.registerCommand('tara.openKanban', () => {
      vscode.commands.executeCommand('tara.kanbanView.focus');
    }),

    vscode.commands.registerCommand('tara.startVoice', () => {
      chatProvider.triggerVoiceStart();
    }),

    vscode.commands.registerCommand('tara.stopAgent', () => {
      orchestrator?.stopAll();
    })
  );

  // ── Context Keys ──────────────────────────────────────────────────────────
  orchestrator.onStatusChange((hasRunning) => {
    vscode.commands.executeCommand('setContext', 'tara.agentRunning', hasRunning);
  });

  vscode.commands.executeCommand('setContext', 'tara.chatViewFocused', false);

  console.log('[Tara] Extension activated ✓');
}

export function deactivate() {
  orchestrator?.dispose();
  console.log('[Tara] Extension deactivated');
}
