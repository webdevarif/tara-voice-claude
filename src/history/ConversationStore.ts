// ─────────────────────────────────────────────────────────────────────────────
// ConversationStore — per-project chat history that outlives the extension.
//
// Not `globalState`, not `workspaceState`, not `globalStorageUri`: all three are
// storage VS Code owns on the extension's behalf, and it prunes them as part of
// extension management (the shared process wires `extensionStorageService` into
// the same cleanup that removes outdated extension versions). Anything kept
// there is gone the moment the extension is uninstalled — which is precisely the
// case this has to survive.
//
// So the file lives under the user's home directory, in a folder this extension
// owns outright, and is keyed by the workspace path. Uninstalling touches
// nothing here, and reinstalling finds the same file.
//
// Not inside the project either: history would land in the repository, show up
// in `git status`, and be swept away by `git clean`. Keyed *by* the project,
// stored outside it.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { ChatEntry } from '../types';

/** Bumped only if the on-disk shape changes incompatibly. */
const FORMAT_VERSION = 1;

/**
 * Enough to scroll back through a long session, bounded so a machine left
 * running for weeks cannot grow an unbounded file.
 */
const MAX_ENTRIES = 500;

/** A single entry longer than this is truncated rather than stored whole. */
const MAX_ENTRY_CHARS = 20000;

/**
 * Writes are batched: a busy agent produces entries faster than a disk should be
 * asked to keep up with, and none of them are worth a synchronous flush.
 */
const WRITE_DEBOUNCE_MS = 1200;

interface StoredConversation {
  version: number;
  /** Recorded for diagnosis; the filename hash is what actually identifies it. */
  workspace: string;
  updatedAt: string;
  entries: ChatEntry[];
}

export class ConversationStore {
  private readonly file: string;
  private readonly workspacePath: string;
  private entries: ChatEntry[] = [];
  private timer?: NodeJS.Timeout;
  private loaded = false;
  /** Set after a write failure so the log is not flooded with the same error. */
  private warned = false;

  /**
   * @param workspacePath Absolute path of the project, or empty for a window
   *   with no folder open — which gets its own bucket rather than being mixed
   *   in with a real project's history.
   */
  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    const dir = path.join(os.homedir(), '.tara', 'conversations');
    this.file = path.join(dir, ConversationStore.fileNameFor(workspacePath));
  }

  /**
   * A readable prefix plus a hash of the full path. The prefix is for a human
   * looking in the folder; the hash is what makes it unique, since two projects
   * can share a basename and a path can contain characters a filename cannot.
   */
  static fileNameFor(workspacePath: string): string {
    const normalized = workspacePath.trim();
    if (!normalized) {
      return 'no-folder.json';
    }
    // Case-insensitive on Windows and macOS: the same project reached through a
    // differently-cased path must not get a second history file.
    const key = process.platform === 'linux' ? normalized : normalized.toLowerCase();
    const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
    const slug =
      path
        .basename(normalized)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'workspace';
    return `${slug}-${hash}.json`;
  }

  /** Absolute path of the file backing this conversation, for diagnostics. */
  get path(): string {
    return this.file;
  }

  /**
   * Reads the stored conversation. A missing or unreadable file yields an empty
   * history rather than an error: losing history is bad, but refusing to open
   * the panel because of it would be worse.
   */
  load(): ChatEntry[] {
    if (this.loaded) {
      return this.entries;
    }
    this.loaded = true;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as StoredConversation;
      if (parsed?.version === FORMAT_VERSION && Array.isArray(parsed.entries)) {
        this.entries = parsed.entries.filter(isEntry);
      }
    } catch {
      // Absent on first run; unreadable is handled the same way.
    }
    return this.entries;
  }

  append(entry: ChatEntry): void {
    this.load();
    this.entries.push(
      entry.content.length > MAX_ENTRY_CHARS
        ? { ...entry, content: `${entry.content.slice(0, MAX_ENTRY_CHARS)}\n…[truncated]` }
        : entry
    );
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    this.schedule();
  }

  clear(): void {
    this.load();
    this.entries = [];
    this.schedule();
  }

  private schedule() {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, WRITE_DEBOUNCE_MS);
  }

  /** Writes immediately. Called on dispose so a closing window loses nothing. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const payload: StoredConversation = {
      version: FORMAT_VERSION,
      workspace: this.workspacePath,
      updatedAt: new Date().toISOString(),
      entries: this.entries,
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // Written beside the target and renamed: a crash or a full disk during the
      // write then leaves the previous history intact instead of half a file.
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, this.file);
      this.warned = false;
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        console.warn(
          `[tara] could not save conversation history to ${this.file}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  dispose(): void {
    this.flush();
  }
}

function isEntry(value: unknown): value is ChatEntry {
  const e = value as ChatEntry | undefined;
  return (
    !!e &&
    typeof e.id === 'string' &&
    typeof e.content === 'string' &&
    typeof e.timestamp === 'number' &&
    (e.role === 'user' || e.role === 'tara' || e.role === 'claude' || e.role === 'system')
  );
}
