// ─────────────────────────────────────────────────────────────────────────────
// Tara — Shared Types
// ─────────────────────────────────────────────────────────────────────────────

export type AgentStatus =
  | 'idle'
  | 'running'
  | 'waiting_for_input'
  | 'done'
  | 'error'
  | 'stopped';

export interface TaraMessage {
  type: TaraMessageType;
  payload: unknown;
}

export type TaraMessageType =
  // Webview → Extension
  | 'VOICE_AUDIO_CHUNK'      // base64-encoded PCM chunk from mic
  | 'VOICE_START'            // user pressed push-to-talk
  | 'VOICE_STOP'             // user released push-to-talk
  | 'SEND_COMMAND'           // text command submitted from chat input
  | 'STOP_AGENT'             // user clicked stop
  | 'CONFIRM_EXECUTION'      // user confirmed risky command
  | 'CANCEL_EXECUTION'       // user cancelled risky command
  | 'OPEN_SETTINGS'          // user clicked settings gear
  | 'CHECK_SETUP'            // webview requests setup status check
  | 'SAVE_API_KEY'           // webview sends gemini API key to save
  | 'OPEN_URL'               // webview asks extension to open a URL
  | 'SET_MIC_DEVICE'          // webview tells extension which mic device to use
  // Extension → Webview
  | 'TRANSCRIPT_TOKEN'       // streaming STT token
  | 'TRANSCRIPT_DONE'        // full transcript finalized
  | 'AGENT_OUTPUT'           // streaming Claude output line
  | 'AGENT_STATUS'           // agent status change
  | 'TTS_AUDIO_CHUNK'        // base64-encoded TTS audio from Gemini
  | 'TTS_DONE'               // TTS stream complete
  | 'RISK_CONFIRM_REQUEST'   // risky command detected — ask user to confirm
  | 'KANBAN_UPDATE'          // full kanban board state
  | 'ERROR'                  // error message to display
  | 'INIT'                   // initial state on panel load
  | 'SETUP_STATUS'           // extension reports setup check results

export interface ChatEntry {
  id: string;
  role: 'user' | 'tara' | 'claude' | 'system';
  content: string;
  timestamp: number;
  streaming?: boolean;
}

export interface KanbanCard {
  id: string;
  title: string;
  status: 'todo' | 'in_progress' | 'needs_input' | 'done' | 'error';
  agentPid?: number;
  startedAt?: number;
  completedAt?: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface KanbanBoard {
  cards: KanbanCard[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

// Risk patterns — commands that require confirmation before execution
export const RISK_PATTERNS: RegExp[] = [
  /\bdelete\b/i,
  /\bdrop\s+(table|database|collection)\b/i,
  /\bforce\s+push\b/i,
  /\brm\s+-rf\b/i,
  /\btruncate\b/i,
  /\bpurge\b/i,
  /\bnuke\b/i,
  /\bdestructive\b/i,
];

export function isRiskyCommand(command: string): boolean {
  return RISK_PATTERNS.some((pattern) => pattern.test(command));
}

// Pricing constants (Claude Sonnet 3.5 as default)
export const CLAUDE_PRICING = {
  inputPerMToken: 3.0,   // USD per million input tokens
  outputPerMToken: 15.0, // USD per million output tokens
};

export function estimateCostUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * CLAUDE_PRICING.inputPerMToken +
    (outputTokens / 1_000_000) * CLAUDE_PRICING.outputPerMToken
  );
}
