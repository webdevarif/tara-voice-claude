import * as vscode from 'vscode';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import {
  AgentStatus,
  KanbanBoard,
  KanbanCard,
  estimateCostUsd,
  isRiskyCommand,
} from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// ClaudeCodeRunner — manages a single Claude Code CLI process
// ─────────────────────────────────────────────────────────────────────────────
export class ClaudeCodeRunner extends EventEmitter {
  readonly id: string;
  private process?: ChildProcessWithoutNullStreams;
  private _status: AgentStatus = 'idle';
  card: KanbanCard;

  constructor(id: string, title: string) {
    super();
    this.id = id;
    this.card = {
      id,
      title,
      status: 'todo',
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
    };
  }

  get status(): AgentStatus {
    return this._status;
  }

  private setStatus(s: AgentStatus) {
    this._status = s;
    this.card.status =
      s === 'done' ? 'done'
      : s === 'error' ? 'error'
      : s === 'running' ? 'in_progress'
      : s === 'waiting_for_input' ? 'needs_input'
      : 'todo';
    this.emit('statusChange', s);
  }

  async run(
    prompt: string,
    workspacePath: string,
    claudePath: string
  ): Promise<void> {
    if (this._status === 'running') {
      throw new Error(`Agent ${this.id} is already running`);
    }

    this.setStatus('running');
    this.card.startedAt = Date.now();

    return new Promise((resolve, reject) => {
      const args = [
        '--print',           // non-interactive streaming mode
        '--output-format', 'stream-json', // structured streaming output
        '--max-turns', '10',
        prompt,
      ];

      this.process = spawn(claudePath, args, {
        cwd: workspacePath,
        env: { ...process.env },
        shell: true,
      });

      this.process.stdout.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          this.handleOutputLine(line);
        }
      });

      this.process.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        this.emit('output', { type: 'error', text });
      });

      this.process.on('close', (code) => {
        this.card.completedAt = Date.now();
        if (code === 0 || code === null) {
          this.setStatus('done');
          resolve();
        } else if (this._status !== 'stopped') {
          this.setStatus('error');
          reject(new Error(`Claude process exited with code ${code}`));
        } else {
          resolve();
        }
      });

      this.process.on('error', (err) => {
        this.setStatus('error');
        this.emit('output', {
          type: 'error',
          text: `Failed to start Claude Code: ${err.message}\n\nMake sure 'claude' is installed and in your PATH.\nInstall: npm install -g @anthropic-ai/claude-code`,
        });
        reject(err);
      });
    });
  }

  private handleOutputLine(line: string) {
    try {
      const parsed = JSON.parse(line);

      // Stream-json format from claude CLI
      if (parsed.type === 'assistant') {
        const content = parsed.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              this.emit('output', { type: 'text', text: block.text });
            } else if (block.type === 'tool_use') {
              this.emit('output', {
                type: 'tool',
                text: `🔧 ${block.name}: ${JSON.stringify(block.input, null, 2)}`,
              });
            }
          }
        }

        // Track token usage
        const usage = parsed.message?.usage;
        if (usage) {
          this.card.inputTokens += usage.input_tokens ?? 0;
          this.card.outputTokens += usage.output_tokens ?? 0;
          this.card.estimatedCostUsd = estimateCostUsd(
            this.card.inputTokens,
            this.card.outputTokens
          );
          this.emit('costUpdate', this.card.estimatedCostUsd);
        }
      } else if (parsed.type === 'result') {
        if (parsed.result) {
          this.emit('output', { type: 'result', text: parsed.result });
        }
      } else if (parsed.type === 'system') {
        // Session info, ignore or log
      }
    } catch {
      // Not JSON — plain text output
      if (line.trim()) {
        this.emit('output', { type: 'text', text: line });
      }
    }
  }

  sendInput(text: string) {
    if (this.process?.stdin) {
      this.process.stdin.write(text + '\n');
      this.setStatus('running');
    }
  }

  stop() {
    if (this.process) {
      this.setStatus('stopped');
      this.process.kill('SIGTERM');
      // Force kill after 3s
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 3000);
    }
  }

  dispose() {
    this.stop();
    this.removeAllListeners();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentOrchestrator — manages up to N ClaudeCodeRunners, broadcasts Kanban
// ─────────────────────────────────────────────────────────────────────────────
export class AgentOrchestrator extends EventEmitter {
  private runners: Map<string, ClaudeCodeRunner> = new Map();
  private board: KanbanBoard = {
    cards: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
  };
  private context: vscode.ExtensionContext;
  private idCounter = 0;

  // Callbacks
  private _onOutput?: (agentId: string, data: { type: string; text: string }) => void;

  constructor(context: vscode.ExtensionContext) {
    super();
    this.context = context;
  }

  get maxConcurrent(): number {
    return vscode.workspace
      .getConfiguration('tara')
      .get<number>('maxConcurrentAgents', 3);
  }

  get claudePath(): string {
    return vscode.workspace
      .getConfiguration('tara')
      .get<string>('claudeCodePath', 'claude');
  }

  get workspacePath(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? process.cwd();
  }

  onOutput(cb: (agentId: string, data: { type: string; text: string }) => void) {
    this._onOutput = cb;
  }

  onKanbanUpdate(cb: (board: KanbanBoard) => void) {
    this.on('kanbanUpdate', cb);
  }

  onStatusChange(cb: (hasRunning: boolean) => void) {
    this.on('statusChange', cb);
  }

  async runTask(prompt: string): Promise<string> {
    const runningCount = [...this.runners.values()].filter(
      (r) => r.status === 'running'
    ).length;

    if (runningCount >= this.maxConcurrent) {
      throw new Error(
        `Maximum concurrent agents (${this.maxConcurrent}) reached. Wait for one to finish or stop an agent.`
      );
    }

    const id = `agent-${++this.idCounter}`;
    const title = prompt.length > 60 ? prompt.slice(0, 57) + '...' : prompt;
    const runner = new ClaudeCodeRunner(id, title);

    runner.on('output', (data) => {
      this._onOutput?.(id, data);
    });

    runner.on('statusChange', () => {
      this.syncBoard();
      const hasRunning = [...this.runners.values()].some(
        (r) => r.status === 'running'
      );
      this.emit('statusChange', hasRunning);

      if (runner.status === 'done') {
        vscode.window.showInformationMessage(
          `✅ Tara: Task complete — "${title}"`,
          'View Chat'
        );
      } else if (runner.status === 'error') {
        vscode.window.showErrorMessage(
          `❌ Tara: Task failed — "${title}"`
        );
      }
    });

    runner.on('costUpdate', () => {
      this.syncBoard();
    });

    this.runners.set(id, runner);
    this.syncBoard();

    // Run async — don't await so caller gets id immediately
    runner
      .run(prompt, this.workspacePath, this.claudePath)
      .catch((err) => {
        console.error(`[Tara] Agent ${id} error:`, err);
      });

    return id;
  }

  private syncBoard() {
    const cards = [...this.runners.values()].map((r) => r.card);
    this.board = {
      cards,
      totalInputTokens: cards.reduce((a, c) => a + c.inputTokens, 0),
      totalOutputTokens: cards.reduce((a, c) => a + c.outputTokens, 0),
      totalCostUsd: cards.reduce((a, c) => a + c.estimatedCostUsd, 0),
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
    this.stopAll();
    this.removeAllListeners();
  }
}
