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
  | 'WEBVIEW_READY'           // webview has subscribed and wants its initial state
  | 'VOICE_START'             // user pressed push-to-talk
  | 'VOICE_STOP'              // user released push-to-talk
  | 'SEND_COMMAND'            // text command submitted from chat input
  | 'REPLY_TO_AGENT'          // answer to a clarifying question from an agent
  | 'STOP_AGENT'              // user clicked stop
  | 'CONFIRM_EXECUTION'       // user confirmed risky command
  | 'CANCEL_EXECUTION'        // user cancelled risky command
  | 'OPEN_SETTINGS'           // user clicked settings gear
  | 'CHECK_SETUP'             // webview requests setup status check
  | 'SAVE_API_KEY'            // webview sends gemini API key to save
  | 'OPEN_URL'                // webview asks extension to open a URL
  | 'SET_MIC_DEVICE'          // webview picks an ffmpeg capture device
  | 'INSTALL_FFMPEG'          // webview asks for the ffmpeg install command in a terminal
  | 'SETUP_COMPLETE'          // webview reports setup finished; persist it
  // Extension → Webview
  | 'TRANSCRIPT_TOKEN'        // streaming STT token
  | 'TRANSCRIPT_DONE'         // full transcript finalized
  | 'AGENT_OUTPUT'            // streaming Claude output line
  | 'AGENT_STATUS'            // aggregate agent status change
  | 'AGENT_QUESTION'          // an agent is blocked on a clarifying question
  | 'TTS_AUDIO_CHUNK'         // base64-encoded 24 kHz PCM TTS audio from Gemini
  | 'TTS_DONE'                // TTS stream complete
  | 'RISK_CONFIRM_REQUEST'    // risky command detected — ask user to confirm
  | 'KANBAN_UPDATE'           // full kanban board state
  | 'ERROR'                   // error message to display
  | 'INIT'                    // initial state on panel load
  | 'SETUP_STATUS'            // extension reports setup check results
  | 'VOICE_STATE';            // Gemini session state, and/or `mic` capture state

export interface ChatEntry {
  id: string;
  role: 'user' | 'tara' | 'claude' | 'system';
  content: string;
  timestamp: number;
  streaming?: boolean;
}

/**
 * Token usage as reported by the Anthropic API. The four buckets are disjoint:
 * `inputTokens` excludes anything served from or written to the prompt cache,
 * so a correct cost estimate has to price all four separately.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}

export function totalTokens(u: TokenUsage): number {
  return (
    u.inputTokens + u.outputTokens + u.cacheCreationTokens + u.cacheReadTokens
  );
}

export interface KanbanCard {
  id: string;
  title: string;
  status: 'todo' | 'in_progress' | 'needs_input' | 'done' | 'error';
  startedAt?: number;
  completedAt?: number;
  /** Question text when status is `needs_input`. */
  question?: string;
  usage: TokenUsage;
  /**
   * Cost in USD. Authoritative once the CLI reports `total_cost_usd` on its
   * result event; before that it is a cache-aware estimate from `usage`.
   */
  costUsd: number;
  /** True once `costUsd` came from the CLI rather than our own estimate. */
  costIsReported: boolean;
  model?: string;
}

export interface KanbanBoard {
  cards: KanbanCard[];
  totalUsage: TokenUsage;
  totalCostUsd: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Risk detection
//
// These match the *prompt*, which is a coarse signal — the real danger is in the
// tool calls Claude ends up making, which `tara.permissionMode` governs. Keep
// the patterns narrow: a prompt like "delete the unused import" must not prompt
// for confirmation, or users learn to click through the dialog.
// ─────────────────────────────────────────────────────────────────────────────
export const RISK_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*[rf]/i,
  /\bgit\s+push\b[^\n]*--force|\bforce[\s-]push\b/i,
  /\bgit\s+reset\b[^\n]*--hard/i,
  /\bgit\s+clean\b[^\n]*-[a-z]*[fd]/i,
  /\bdrop\s+(table|database|schema|collection|index)\b/i,
  /\btruncate\s+table\b/i,
  /\bdelete\s+from\b/i,
  /\bdelete\s+(the\s+)?(repo|repository|branch|database|table|bucket|volume|cluster|namespace|production|prod)\b/i,
  /\bdrop\s+(the\s+)?(database|db)\b/i,
  /\b(wipe|nuke|purge|obliterate)\b/i,
  /\bformat\s+(the\s+)?(disk|drive|volume)\b/i,
  /\brevoke\s+(all\s+)?(keys|credentials|tokens)\b/i,
];

export function isRiskyCommand(command: string): boolean {
  return RISK_PATTERNS.some((pattern) => pattern.test(command));
}

// ─────────────────────────────────────────────────────────────────────────────
// Pricing
//
// USD per million tokens. Cache writes bill at 1.25x the input rate (5-minute
// TTL) and cache reads at 0.1x, so both are derived rather than tabulated.
// ─────────────────────────────────────────────────────────────────────────────
export interface ModelRate {
  input: number;
  output: number;
}

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/**
 * Matched against the model id reported by the CLI, longest key first, so
 * `claude-opus-4-8` wins over `claude-opus`.
 */
export const MODEL_RATES: Record<string, ModelRate> = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

const DEFAULT_RATE: ModelRate = MODEL_RATES['claude-opus-5'];

export function resolveRate(model?: string): ModelRate {
  if (!model) {
    return DEFAULT_RATE;
  }
  const id = model.toLowerCase();
  let best: { key: string; rate: ModelRate } | undefined;
  for (const [key, rate] of Object.entries(MODEL_RATES)) {
    if (id.includes(key) && (!best || key.length > best.key.length)) {
      best = { key, rate };
    }
  }
  if (best) {
    return best.rate;
  }
  // Unknown id — fall back by family so a new snapshot still costs sanely.
  if (id.includes('haiku')) {
    return MODEL_RATES['claude-haiku-4-5'];
  }
  if (id.includes('sonnet')) {
    return MODEL_RATES['claude-sonnet-5'];
  }
  return DEFAULT_RATE;
}

export function estimateCostUsd(usage: TokenUsage, model?: string): number {
  const rate = resolveRate(model);
  return (
    (usage.inputTokens / 1_000_000) * rate.input +
    (usage.outputTokens / 1_000_000) * rate.output +
    (usage.cacheCreationTokens / 1_000_000) * rate.input * CACHE_WRITE_MULTIPLIER +
    (usage.cacheReadTokens / 1_000_000) * rate.input * CACHE_READ_MULTIPLIER
  );
}
