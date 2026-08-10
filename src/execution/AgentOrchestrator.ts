import * as vscode from 'vscode';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import {
  AgentStatus,
  KanbanBoard,
  KanbanCard,
  TokenUsage,
  addUsage,
  emptyUsage,
  estimateCostUsd,
} from '../types';

export interface AgentOutput {
  type: 'text' | 'tool' | 'result' | 'error' | 'system';
  text: string;
}

export interface RunnerOptions {
  claudePath: string;
  workspacePath: string;
  maxTurns: number;
  permissionMode: string;
  model?: string;
  /** How long to hold a session open waiting for the user to answer a question. */
  replyTimeoutMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Executable resolution
//
// `spawn` with `shell: false` cannot launch a Windows `.cmd`/`.bat` shim, and
// `claude` on Windows is exactly that. Resolving the real path up front lets us
// keep `shell: false`, which is what stops shell metacharacters in a voice
// transcript from being executed.
// ─────────────────────────────────────────────────────────────────────────────
export function resolveExecutable(command: string): string | undefined {
  if (command.includes(path.sep) || command.includes('/')) {
    return fs.existsSync(command) ? command : undefined;
  }

  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
          .map((e) => e.toLowerCase())
      : [''];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // Not there — keep looking.
      }
    }
  }
  return undefined;
}

export interface LaunchSpec {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

/** Quotes one argument for a cmd.exe command line. */
function quoteWindowsArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * Builds a spawnable command for the Claude CLI.
 *
 * On Windows `claude` is a `.cmd` shim, and since Node 20 (the CVE-2024-27980
 * mitigation) `spawn` refuses to launch `.cmd`/`.bat` with `shell: false` — it
 * fails with EINVAL. The fix is to invoke cmd.exe ourselves with an explicitly
 * quoted command line and `windowsVerbatimArguments`, rather than reaching for
 * `shell: true` and letting Node join the arguments with no escaping at all.
 *
 * This stays safe because the prompt travels over stdin, never on the command
 * line; the arguments here are our own constants plus a validated model id.
 */
export function buildLaunchSpec(command: string, args: string[]): LaunchSpec | undefined {
  const resolved = resolveExecutable(command);
  if (!resolved) {
    return undefined;
  }
  const isBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
  if (!isBatch) {
    return { file: resolved, args };
  }
  const comspec = process.env.ComSpec || 'cmd.exe';
  const line = [resolved, ...args].map(quoteWindowsArg).join(' ');
  // `/s` makes cmd strip exactly the outer quote pair and take the rest verbatim.
  return {
    file: comspec,
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * A model id must be safe to place on a cmd.exe command line. Anything with a
 * quote or a `%` is dropped rather than escaped — a malformed setting should
 * fall back to the CLI default, not become a quoting puzzle.
 */
export function sanitizeModelId(model: string | undefined): string | undefined {
  const trimmed = (model ?? '').trim();
  if (!trimmed) {
    return undefined;
  }
  return /^[A-Za-z0-9._:@/\-[\]]+$/.test(trimmed) ? trimmed : undefined;
}

/** Kill a process and everything it spawned. */
function killTree(pid: number) {
  if (process.platform === 'win32') {
    // Node's kill() maps every signal to TerminateProcess, which leaves the
    // CLI's own children running. taskkill /T takes the whole tree.
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => {
      /* best effort */
    });
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Heuristic: did the agent end its turn by asking the user something?
 * Only the tail matters — a long answer that happens to contain a question
 * mark mid-paragraph is not a prompt for input.
 */
function looksLikeQuestion(text: string): boolean {
  const tail = text.trimEnd().slice(-400);
  if (!tail) {
    return false;
  }
  if (tail.endsWith('?')) {
    return true;
  }
  return /\b(which|would you|should i|do you want|let me know|please (confirm|specify|clarify))\b[^.?!]*\?/i.test(
    tail
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ClaudeCodeRunner — one long-lived `claude` process, driven over stdin
//
// Runs with `--input-format stream-json` and keeps stdin open, so the session
// survives past the first turn and the user can answer clarifying questions.
// ─────────────────────────────────────────────────────────────────────────────
export class ClaudeCodeRunner extends EventEmitter {
  readonly id: string;
  card: KanbanCard;

  private child?: ChildProcessWithoutNullStreams;
  private _status: AgentStatus = 'idle';
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private sessionId?: string;
  private turnText = '';
  private replyTimer?: NodeJS.Timeout;
  private replyTimeoutMs = 300_000;
  private maxTurns = 0;
  private lastRateLimitStatus?: string;
  private exited = false;

  constructor(id: string, title: string) {
    super();
    this.id = id;
    this.card = {
      id,
      title,
      status: 'todo',
      usage: emptyUsage(),
      costUsd: 0,
      costIsReported: false,
    };
  }

  get status(): AgentStatus {
    return this._status;
  }

  get isAlive(): boolean {
    return !!this.child && !this.exited;
  }

  private setStatus(s: AgentStatus) {
    if (this._status === s) {
      return;
    }
    this._status = s;
    this.card.status =
      s === 'done'
        ? 'done'
        : s === 'error'
          ? 'error'
          : s === 'running'
            ? 'in_progress'
            : s === 'waiting_for_input'
              ? 'needs_input'
              : 'todo';
    if (s !== 'waiting_for_input') {
      this.card.question = undefined;
    }
    this.emit('statusChange', s);
  }

  start(prompt: string, opts: RunnerOptions): void {
    if (this.child) {
      throw new Error(`Agent ${this.id} has already been started`);
    }

    this.replyTimeoutMs = opts.replyTimeoutMs;
    this.maxTurns = opts.maxTurns;

    const args = [
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose', // required for stream-json to emit per-event objects
      '--max-turns',
      String(opts.maxTurns),
      '--permission-mode',
      opts.permissionMode,
    ];
    if (opts.model) {
      args.push('--model', opts.model);
    }

    const launch = buildLaunchSpec(opts.claudePath, args);
    if (!launch) {
      this.setStatus('error');
      this.emit('output', {
        type: 'error',
        text:
          `Could not find "${opts.claudePath}" on your PATH.\n\n` +
          `Install it with:  npm install -g @anthropic-ai/claude-code\n` +
          `Or set "tara.claudeCodePath" to the full path of the binary.`,
      } satisfies AgentOutput);
      return;
    }

    this.setStatus('running');
    this.card.startedAt = Date.now();

    try {
      this.child = spawn(launch.file, launch.args, {
        cwd: opts.workspacePath,
        // No shell: the prompt travels over stdin, and keeping the shell out of
        // the picture means metacharacters in a transcript stay inert.
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
        detached: process.platform !== 'win32', // own process group, for killTree
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      this.setStatus('error');
      this.emit('output', {
        type: 'error',
        text: `Failed to start Claude Code: ${err instanceof Error ? err.message : String(err)}`,
      } satisfies AgentOutput);
      return;
    }

    this.child.stdout.setEncoding('utf-8');
    this.child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));

    this.child.stderr.setEncoding('utf-8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer += chunk;
      if (this.stderrBuffer.length > 8000) {
        this.stderrBuffer = this.stderrBuffer.slice(-8000);
      }
    });

    this.child.stdin.on('error', () => {
      // The CLI closed stdin (normal once a session ends) — nothing to do.
    });

    this.child.on('error', (err) => {
      this.exited = true;
      this.setStatus('error');
      this.emit('output', {
        type: 'error',
        text: `Failed to start Claude Code: ${err.message}`,
      } satisfies AgentOutput);
      this.emit('finished');
    });

    this.child.on('close', (code) => {
      this.exited = true;
      this.clearReplyTimer();
      this.flushStdout();
      this.card.completedAt = Date.now();

      if (
        this._status === 'stopped' ||
        this._status === 'done' ||
        this._status === 'error'
      ) {
        this.emit('finished');
        return;
      }
      // Exited without a terminal result event.
      if (code === 0 || code === null) {
        this.setStatus('done');
      } else {
        this.setStatus('error');
        const detail = this.stderrBuffer.trim();
        this.emit('output', {
          type: 'error',
          text: detail
            ? `Claude Code exited with code ${code}:\n${detail}`
            : `Claude Code exited with code ${code}.`,
        } satisfies AgentOutput);
      }
      this.emit('finished');
    });

    this.sendUserMessage(prompt);
  }

  /** Answer a clarifying question and resume the same session. */
  sendReply(text: string): boolean {
    if (!this.isAlive || !this.child?.stdin.writable) {
      return false;
    }
    this.clearReplyTimer();
    this.turnText = '';
    this.setStatus('running');
    return this.sendUserMessage(text);
  }

  private sendUserMessage(text: string): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || !stdin.writable) {
      return false;
    }
    const envelope = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
    try {
      // Deliberately ignoring write()'s return value: it is a backpressure hint
      // (buffer past highWaterMark), not a delivery result. Returning it made a
      // long reply look like "nobody was waiting", and the caller then spawned a
      // second agent for text the CLI had already accepted.
      stdin.write(JSON.stringify(envelope) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  // ── stdout parsing ─────────────────────────────────────────────────────────

  private consumeStdout(chunk: string) {
    this.stdoutBuffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
    }
  }

  private flushStdout() {
    const rest = this.stdoutBuffer;
    this.stdoutBuffer = '';
    if (rest.trim()) {
      this.handleLine(rest);
    }
  }

  private handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Not JSON — surface it rather than swallowing it, so startup errors and
      // stray CLI notices are visible instead of vanishing.
      this.emit('output', { type: 'text', text: trimmed } satisfies AgentOutput);
      return;
    }

    switch (event.type) {
      case 'system':
        this.handleSystem(event);
        break;
      case 'assistant':
        this.handleAssistant(event);
        break;
      case 'result':
        this.handleResult(event);
        break;
      case 'rate_limit_event':
        this.handleRateLimit(event);
        break;
      case 'user':
        // Echo of our own stdin when --replay-user-messages is on. Ignore.
        break;
      default:
        break;
    }
  }

  /**
   * `rate_limit_event` is a routine quota heartbeat — it arrives on ordinary
   * successful runs with `status: "allowed"`. Announcing every one of them put a
   * scary "Rate limit reached" bubble in the transcript of tasks that were never
   * throttled, so only real state changes are surfaced.
   */
  private handleRateLimit(event: Record<string, unknown>) {
    const info = event.rate_limit_info;
    const status =
      info && typeof info === 'object'
        ? (info as Record<string, unknown>).status
        : undefined;
    const state = typeof status === 'string' ? status : 'unknown';

    if (state === 'allowed' || state === this.lastRateLimitStatus) {
      this.lastRateLimitStatus = state;
      return;
    }
    this.lastRateLimitStatus = state;
    this.emit('output', {
      type: 'system',
      text:
        state === 'rejected'
          ? 'Rate limit reached — Claude Code is waiting before it retries.'
          : `Rate limit status: ${state}.`,
    } satisfies AgentOutput);
  }

  private handleSystem(event: Record<string, unknown>) {
    if (event.subtype === 'init') {
      if (typeof event.session_id === 'string') {
        this.sessionId = event.session_id;
      }
      if (typeof event.model === 'string') {
        this.card.model = event.model;
      }
    }
  }

  private handleAssistant(event: Record<string, unknown>) {
    const message = event.message as
      | {
          model?: string;
          content?: Array<Record<string, unknown>>;
          usage?: Record<string, unknown>;
        }
      | undefined;
    if (!message) {
      return;
    }

    if (typeof message.model === 'string') {
      this.card.model = message.model;
    }

    for (const block of message.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') {
        this.turnText += block.text;
        this.emit('output', { type: 'text', text: block.text } satisfies AgentOutput);
      } else if (block.type === 'tool_use') {
        const name = typeof block.name === 'string' ? block.name : 'tool';
        this.emit('output', {
          type: 'tool',
          text: `${name} ${summarizeToolInput(block.input)}`.trim(),
        } satisfies AgentOutput);
      }
    }

    // Per-API-call usage, so summing it across the session is correct — each
    // call bills its own input, and the four buckets are disjoint. Cost is only
    // estimated from it until the result event reports the real figure.
    if (message.usage) {
      this.card.usage = addUsage(this.card.usage, readUsage(message.usage));
      if (!this.card.costIsReported) {
        this.card.costUsd = estimateCostUsd(this.card.usage, this.card.model);
      }
      this.emit('costUpdate');
    }
  }

  private handleResult(event: Record<string, unknown>) {
    if (typeof event.session_id === 'string') {
      this.sessionId = event.session_id;
    }

    // `total_cost_usd` is cumulative across the whole session (verified: it grows
    // turn over turn), so it replaces rather than adds. Token counts keep coming
    // from the summed per-call assistant usage, whose semantics are unambiguous.
    if (typeof event.total_cost_usd === 'number') {
      this.card.costUsd = event.total_cost_usd;
      this.card.costIsReported = true;
    }
    const canonical = readCanonicalModel(event.modelUsage);
    if (canonical) {
      this.card.model = canonical;
    }
    this.emit('costUpdate');

    const resultText = typeof event.result === 'string' ? event.result : '';
    const finalText = resultText.trim() ? resultText : this.turnText;

    // Checked before the generic error branch: a max-turns result also carries
    // `is_error: true`, and it has no `result` field at all, so the generic
    // branch would swallow it and print "Claude Code reported an error."
    if (event.subtype === 'error_max_turns' || event.terminal_reason === 'max_turns') {
      this.setStatus('error');
      this.emit('output', {
        type: 'error',
        text:
          `Stopped after the maximum of ${String(event.num_turns ?? this.maxTurns)} turns. ` +
          `Raise "tara.maxTurns" if the task needs more.`,
      } satisfies AgentOutput);
      this.finishSession();
      return;
    }

    if (event.is_error === true || event.subtype === 'error_during_execution') {
      this.setStatus('error');
      this.emit('output', {
        type: 'error',
        // The CLI reports failures in `errors[]` when there is no `result`.
        text:
          (resultText.trim() ? resultText : '') ||
          readErrors(event.errors) ||
          (typeof event.api_error_status === 'string' ? event.api_error_status : '') ||
          'Claude Code reported an error.',
      } satisfies AgentOutput);
      this.finishSession();
      return;
    }

    if (finalText && !this.turnText) {
      // `--print` may only deliver the answer on the result event.
      this.emit('output', { type: 'result', text: finalText } satisfies AgentOutput);
    }

    if (looksLikeQuestion(finalText)) {
      this.card.question = finalText.trimEnd().slice(-600);
      this.setStatus('waiting_for_input');
      this.emit('question', this.card.question);
      // Hold the session open, but not forever.
      this.replyTimer = setTimeout(() => {
        if (this._status === 'waiting_for_input') {
          this.emit('output', {
            type: 'system',
            text: 'No answer received — closing this agent session.',
          } satisfies AgentOutput);
          this.setStatus('done');
          this.finishSession();
        }
      }, this.replyTimeoutMs);
      return;
    }

    this.setStatus('done');
    this.finishSession();
  }

  /** Close stdin so the CLI shuts down cleanly, then let `close` fire. */
  private finishSession() {
    this.turnText = '';
    this.clearReplyTimer();
    try {
      this.child?.stdin.end();
    } catch {
      /* already closed */
    }
  }

  private clearReplyTimer() {
    if (this.replyTimer) {
      clearTimeout(this.replyTimer);
      this.replyTimer = undefined;
    }
  }

  stop() {
    if (!this.child || this.exited) {
      return;
    }
    this.setStatus('stopped');
    this.clearReplyTimer();
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    if (this.child.pid !== undefined) {
      killTree(this.child.pid);
    }
  }

  dispose() {
    this.stop();
    this.removeAllListeners();
  }
}

function readUsage(raw: Record<string, unknown>): TokenUsage {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: num(raw.input_tokens),
    outputTokens: num(raw.output_tokens),
    cacheCreationTokens: num(raw.cache_creation_input_tokens),
    cacheReadTokens: num(raw.cache_read_input_tokens),
  };
}

/**
 * A failing result carries its explanation in `errors[]` rather than `result`,
 * so this is often the only human-readable detail available.
 */
function readErrors(errors: unknown): string {
  if (!Array.isArray(errors)) {
    return '';
  }
  return errors
    .map((e) => {
      if (typeof e === 'string') {
        return e;
      }
      if (e && typeof e === 'object') {
        const message = (e as Record<string, unknown>).message;
        return typeof message === 'string' ? message : '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** `modelUsage` is keyed by served model id (e.g. `claude-opus-5[1m]`). */
function readCanonicalModel(modelUsage: unknown): string | undefined {
  if (!modelUsage || typeof modelUsage !== 'object') {
    return undefined;
  }
  const entries = modelUsage as Record<string, unknown>;
  for (const value of Object.values(entries)) {
    if (value && typeof value === 'object') {
      const canonical = (value as Record<string, unknown>).canonicalModel;
      if (typeof canonical === 'string') {
        return canonical;
      }
    }
  }
  const keys = Object.keys(entries);
  return keys.length ? keys[0] : undefined;
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') {
    return '';
  }
  const obj = input as Record<string, unknown>;
  // Prefer the fields that say what the tool is actually touching.
  for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'query']) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) {
      return value.length > 160 ? value.slice(0, 157) + '…' : value;
    }
  }
  const json = JSON.stringify(obj);
  return json.length > 160 ? json.slice(0, 157) + '…' : json;
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentOrchestrator — owns the runner pool and the Kanban projection
// ─────────────────────────────────────────────────────────────────────────────
export class AgentOrchestrator extends EventEmitter {
  private runners = new Map<string, ClaudeCodeRunner>();
  private board: KanbanBoard = {
    cards: [],
    totalUsage: emptyUsage(),
    totalCostUsd: 0,
  };
  private idCounter = 0;
  private _onOutput?: (agentId: string, data: AgentOutput) => void;
  /**
   * The most recent terminal outcome. Runners are never removed from the map
   * (their cards are the Kanban board), so folding over every status made a
   * single past failure outrank every later success — the header showed a red
   * "Error" pill for the rest of the window.
   */
  private lastTerminal: AgentStatus = 'idle';

  constructor(private readonly context: vscode.ExtensionContext) {
    super();
    void this.context; // retained for future persistence of session ids
  }

  private config<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration('tara').get<T>(key, fallback);
  }

  get maxConcurrent(): number {
    return Math.max(1, this.config('maxConcurrentAgents', 3));
  }

  get workspacePath(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? process.cwd();
  }

  onOutput(cb: (agentId: string, data: AgentOutput) => void) {
    this._onOutput = cb;
  }

  onKanbanUpdate(cb: (board: KanbanBoard) => void) {
    this.on('kanbanUpdate', cb);
  }

  onStatusChange(cb: (status: AgentStatus, hasActive: boolean) => void) {
    this.on('aggregateStatus', cb);
  }

  onQuestion(cb: (agentId: string, title: string, question: string) => void) {
    this.on('question', cb);
  }

  /** Starts an agent and returns its id. Throws if the pool is full. */
  runTask(prompt: string): string {
    const active = [...this.runners.values()].filter(
      (r) => r.status === 'running' || r.status === 'waiting_for_input'
    ).length;

    if (active >= this.maxConcurrent) {
      throw new Error(
        `Already running ${active} agents (limit ${this.maxConcurrent}). Wait for one to finish, or stop one first.`
      );
    }

    const id = `agent-${++this.idCounter}`;
    const title = prompt.length > 60 ? prompt.slice(0, 57) + '…' : prompt;
    const runner = new ClaudeCodeRunner(id, title);

    runner.on('output', (data: AgentOutput) => this._onOutput?.(id, data));
    runner.on('costUpdate', () => this.syncBoard());
    runner.on('question', (question: string) => {
      this.syncBoard();
      this.emit('question', id, title, question);
    });
    runner.on('statusChange', (status: AgentStatus) => {
      if (status === 'done' || status === 'error' || status === 'stopped') {
        this.lastTerminal = status === 'stopped' ? 'idle' : status;
      }
      this.syncBoard();
      this.emitAggregateStatus();

      if (status === 'done') {
        void vscode.window
          .showInformationMessage(`Tara: finished — "${title}"`, 'Open Chat')
          .then((choice) => {
            if (choice === 'Open Chat') {
              void vscode.commands.executeCommand('tara.chatView.focus');
            }
          });
      } else if (status === 'error') {
        void vscode.window.showErrorMessage(`Tara: failed — "${title}"`);
      }
    });

    this.runners.set(id, runner);
    this.syncBoard();

    runner.start(prompt, {
      claudePath: this.config('claudeCodePath', 'claude'),
      workspacePath: this.workspacePath,
      maxTurns: Math.max(1, this.config('maxTurns', 25)),
      permissionMode: this.config('permissionMode', 'acceptEdits'),
      model: sanitizeModelId(this.config('model', '')),
      replyTimeoutMs: Math.max(30, this.config('replyTimeoutSeconds', 300)) * 1000,
    });

    return id;
  }

  /**
   * Routes a reply to the agent that asked. With no id, answers the
   * longest-waiting one. Returns the agent id, or undefined if nobody is waiting.
   */
  replyToAgent(text: string, agentId?: string): string | undefined {
    const target = agentId
      ? this.runners.get(agentId)
      : [...this.runners.values()]
          .filter((r) => r.status === 'waiting_for_input')
          .sort((a, b) => (a.card.startedAt ?? 0) - (b.card.startedAt ?? 0))[0];

    if (!target || target.status !== 'waiting_for_input') {
      return undefined;
    }
    return target.sendReply(text) ? target.id : undefined;
  }

  hasAgentAwaitingInput(): boolean {
    return [...this.runners.values()].some((r) => r.status === 'waiting_for_input');
  }

  aggregateStatus(): AgentStatus {
    const statuses = [...this.runners.values()].map((r) => r.status);
    if (statuses.includes('running')) {
      return 'running';
    }
    if (statuses.includes('waiting_for_input')) {
      return 'waiting_for_input';
    }
    // Nothing live: report the latest outcome, not the worst one ever seen.
    return this.lastTerminal;
  }

  private emitAggregateStatus() {
    const status = this.aggregateStatus();
    this.emit(
      'aggregateStatus',
      status,
      status === 'running' || status === 'waiting_for_input'
    );
  }

  private syncBoard() {
    const cards = [...this.runners.values()].map((r) => r.card);
    this.board = {
      cards,
      totalUsage: cards.reduce((acc, c) => addUsage(acc, c.usage), emptyUsage()),
      totalCostUsd: cards.reduce((acc, c) => acc + c.costUsd, 0),
    };
    this.emit('kanbanUpdate', this.board);
  }

  stopAgent(id: string) {
    this.runners.get(id)?.stop();
  }

  stopAll() {
    for (const runner of this.runners.values()) {
      runner.stop();
    }
  }

  getBoard(): KanbanBoard {
    return this.board;
  }

  dispose() {
    for (const runner of this.runners.values()) {
      runner.dispose();
    }
    this.runners.clear();
    this.removeAllListeners();
  }
}
