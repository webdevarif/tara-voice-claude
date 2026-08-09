// ─────────────────────────────────────────────────────────────────────────────
// VS Code API wrapper + message bus
// ─────────────────────────────────────────────────────────────────────────────

interface VSCodeAPI {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VSCodeAPI;

let _vscode: VSCodeAPI | null = null;

function getVsCodeApi(): VSCodeAPI | null {
  if (_vscode) return _vscode;
  try {
    _vscode = acquireVsCodeApi();
    return _vscode;
  } catch {
    // Running outside VS Code (e.g., in a browser for development)
    return null;
  }
}

export function postToExtension(message: unknown) {
  const api = getVsCodeApi();
  if (api) {
    api.postMessage(message);
  } else {
    console.log('[Tara/dev] postMessage:', message);
  }
}

type MessageHandler = (msg: { type: string; payload: unknown }) => void;
const handlers: MessageHandler[] = [];

window.addEventListener('message', (event) => {
  const msg = event.data as { type: string; payload: unknown };
  for (const h of handlers) {
    h(msg);
  }
});

export function onExtensionMessage(handler: MessageHandler): () => void {
  handlers.push(handler);
  return () => {
    const idx = handlers.indexOf(handler);
    if (idx >= 0) handlers.splice(idx, 1);
  };
}
