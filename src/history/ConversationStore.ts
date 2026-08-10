// ─────────────────────────────────────────────────────────────────────────────
// ConversationStore — per-project chat sessions that outlive the extension.
//
// Not `globalState`, not `workspaceState`, not `globalStorageUri`: all three are
// storage VS Code owns on the extension's behalf, and it prunes them as part of
// extension management (the shared process wires `extensionStorageService` into
// the same cleanup that removes outdated extension versions). Anything kept
// there is gone the moment the extension is uninstalled — which is precisely the
// case this has to survive.
//
// So the files live under the user's home directory, in a folder this extension
// owns outright, keyed by the workspace path. Uninstalling touches nothing here.
//
// Not inside the project either: history would land in the repository, show up
// in `git status`, and be swept away by `git clean`. Keyed *by* the project,
// stored outside it.
//
// Layout — one directory per project:
//
//   ~/.tara/conversations/<slug>-<sha1>/
//     index.json      { activeId, sessions: [{ id, title, updatedAt, … }] }
//     s_<id>.json     { id, entries: [...] }
//
// Metadata is split from content deliberately: the session list has to render
// immediately, and reading every session's full transcript to show a list of
// titles would make opening the panel slower the longer it had been used.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { ChatEntry } from '../types';

/** 2 = sessions. 1 was a single flat conversation per project, and is migrated. */
const FORMAT_VERSION = 2;

/** Per session. Enough to scroll back through a long day of work. */
const MAX_ENTRIES = 500;

/** A single entry longer than this is truncated rather than stored whole. */
const MAX_ENTRY_CHARS = 20000;

/** Oldest sessions beyond this are dropped, so the folder cannot grow forever. */
const MAX_SESSIONS = 100;

/** Titles are derived from the first thing said; this is where they are cut. */
const MAX_TITLE_CHARS = 60;

/**
 * Writes are batched: a busy agent produces entries faster than a disk should be
 * asked to keep up with, and none of them are worth a synchronous flush.
 */
const WRITE_DEBOUNCE_MS = 1200;

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** True once the title was set by hand, so it stops tracking the first message. */
  titleLocked?: boolean;
}

interface SessionIndex {
  version: number;
  workspace: string;
  activeId: string;
  sessions: SessionMeta[];
}

interface SessionFile {
  version: number;
  id: string;
  entries: ChatEntry[];
}

/** Shape of the v1 file this replaces, read once so nothing is lost on upgrade. */
interface LegacyConversation {
  version: number;
  entries: ChatEntry[];
}

export class ConversationStore {
  private readonly dir: string;
  private readonly legacyFile: string;
  private readonly workspacePath: string;

  private index: SessionIndex;
  private entries: ChatEntry[] = [];
  private entriesDirty = false;
  private indexDirty = false;
  private timer?: NodeJS.Timeout;
  private warned = false;

  /**
   * @param workspacePath Absolute path of the project, or empty for a window
   *   with no folder open — which gets its own bucket rather than being mixed
   *   in with a real project's history.
   */
  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    const root = path.join(os.homedir(), '.tara', 'conversations');
    const key = ConversationStore.keyFor(workspacePath);
    this.dir = path.join(root, key);
    // v1 wrote a flat file next to what is now a directory.
    this.legacyFile = path.join(root, `${key}.json`);

    this.index = this.readIndex();
    this.migrateLegacy();
    if (!this.index.sessions.length) {
      this.newSessionMeta();
    }
    this.entries = this.readEntries(this.index.activeId);
  }

  /**
   * A readable prefix plus a hash of the full path. The prefix is for a human
   * looking in the folder; the hash is what makes it unique, since two projects
   * can share a basename and a path can contain characters a filename cannot.
   */
  static keyFor(workspacePath: string): string {
    const normalized = workspacePath.trim();
    if (!normalized) {
      return 'no-folder';
    }
    // Case-insensitive except on Linux: the same project reached through a
    // differently-cased path must not get a second history.
    const key = process.platform === 'linux' ? normalized : normalized.toLowerCase();
    const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
    const slug =
      path
        .basename(normalized)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'workspace';
    return `${slug}-${hash}`;
  }

  /** Where this project's sessions live, for diagnostics. */
  get path(): string {
    return this.dir;
  }

  get activeId(): string {
    return this.index.activeId;
  }

  /** Newest first, which is the order the list is read in. */
  listSessions(): SessionMeta[] {
    return [...this.index.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  entriesForActive(): ChatEntry[] {
    return this.entries;
  }

  createSession(): SessionMeta {
    this.flush();
    const meta = this.newSessionMeta();
    this.entries = [];
    this.entriesDirty = true;
    this.schedule();
    return meta;
  }

  /** Returns the entries of the session now active, or undefined if unknown. */
  openSession(id: string): ChatEntry[] | undefined {
    if (!this.index.sessions.some((s) => s.id === id)) {
      return undefined;
    }
    if (id === this.index.activeId) {
      return this.entries;
    }
    this.flush();
    this.index.activeId = id;
    this.indexDirty = true;
    this.entries = this.readEntries(id);
    this.entriesDirty = false;
    this.schedule();
    return this.entries;
  }

  renameSession(id: string, title: string): void {
    const meta = this.index.sessions.find((s) => s.id === id);
    if (!meta) {
      return;
    }
    const trimmed = title.trim().slice(0, MAX_TITLE_CHARS);
    meta.title = trimmed || meta.title;
    // A hand-written title must survive the next message, which would otherwise
    // overwrite it as the auto-title does.
    meta.titleLocked = !!trimmed;
    this.indexDirty = true;
    this.schedule();
  }

  /** Deleting the active session leaves another one active — never none. */
  deleteSession(id: string): void {
    const at = this.index.sessions.findIndex((s) => s.id === id);
    if (at < 0) {
      return;
    }
    this.index.sessions.splice(at, 1);
    try {
      fs.rmSync(this.sessionFile(id), { force: true });
    } catch {
      // Already gone, or not ours to remove; the index no longer refers to it.
    }
    if (this.index.activeId === id) {
      const next = this.listSessions()[0];
      if (next) {
        this.index.activeId = next.id;
        this.entries = this.readEntries(next.id);
      } else {
        this.newSessionMeta();
        this.entries = [];
      }
      this.entriesDirty = false;
    }
    this.indexDirty = true;
    this.schedule();
  }

  append(entry: ChatEntry): void {
    this.entries.push(
      entry.content.length > MAX_ENTRY_CHARS
        ? { ...entry, content: `${entry.content.slice(0, MAX_ENTRY_CHARS)}\n…[truncated]` }
        : entry
    );
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    this.entriesDirty = true;

    const meta = this.index.sessions.find((s) => s.id === this.index.activeId);
    if (meta) {
      meta.updatedAt = Date.now();
      meta.messageCount = this.entries.length;
      // The first thing the user says names the session, the way a subject line
      // names an email — and only until they name it themselves.
      if (!meta.titleLocked && entry.role === 'user') {
        const auto = summarise(entry.content);
        if (auto && meta.title === 'New session') {
          meta.title = auto;
        }
      }
    }
    this.indexDirty = true;
    this.schedule();
  }

  private newSessionMeta(): SessionMeta {
    const now = Date.now();
    const meta: SessionMeta = {
      // Time-ordered and unique without a counter, so ids sort chronologically
      // and two windows opening at once cannot collide.
      id: `s_${now.toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
      title: 'New session',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    };
    this.index.sessions.push(meta);
    this.index.activeId = meta.id;
    if (this.index.sessions.length > MAX_SESSIONS) {
      for (const stale of this.listSessions().slice(MAX_SESSIONS)) {
        this.deleteSessionFileOnly(stale.id);
      }
      this.index.sessions = this.listSessions().slice(0, MAX_SESSIONS);
    }
    this.indexDirty = true;
    return meta;
  }

  private deleteSessionFileOnly(id: string) {
    try {
      fs.rmSync(this.sessionFile(id), { force: true });
    } catch {
      /* nothing to remove */
    }
  }

  private sessionFile(id: string): string {
    // Ids are generated here and are [a-z0-9_]; the guard is against an index
    // that has been hand-edited into pointing outside the directory.
    const safe = id.replace(/[^a-zA-Z0-9_]/g, '');
    return path.join(this.dir, `${safe}.json`);
  }

  private readIndex(): SessionIndex {
    const empty: SessionIndex = {
      version: FORMAT_VERSION,
      workspace: this.workspacePath,
      activeId: '',
      sessions: [],
    };
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8')
      ) as SessionIndex;
      if (parsed?.version === FORMAT_VERSION && Array.isArray(parsed.sessions)) {
        const sessions = parsed.sessions.filter(isMeta);
        return {
          version: FORMAT_VERSION,
          workspace: this.workspacePath,
          activeId: sessions.some((s) => s.id === parsed.activeId)
            ? parsed.activeId
            : (sessions[0]?.id ?? ''),
          sessions,
        };
      }
    } catch {
      // Absent on first run; unreadable is handled the same way.
    }
    return empty;
  }

  private readEntries(id: string): ChatEntry[] {
    if (!id) {
      return [];
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.sessionFile(id), 'utf8')) as SessionFile;
      if (Array.isArray(parsed?.entries)) {
        return parsed.entries.filter(isEntry);
      }
    } catch {
      // A session listed in the index but missing on disk reads as empty rather
      // than blocking the panel.
    }
    return [];
  }

  /** Folds a v1 flat conversation into the first session, once. */
  private migrateLegacy() {
    if (this.index.sessions.length) {
      return;
    }
    let legacy: ChatEntry[] = [];
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.legacyFile, 'utf8')
      ) as LegacyConversation;
      if (Array.isArray(parsed?.entries)) {
        legacy = parsed.entries.filter(isEntry);
      }
    } catch {
      return;
    }
    if (!legacy.length) {
      return;
    }
    const meta = this.newSessionMeta();
    const first = legacy.find((e) => e.role === 'user');
    meta.title = (first && summarise(first.content)) || 'Earlier conversation';
    meta.titleLocked = true;
    meta.messageCount = legacy.length;
    meta.updatedAt = legacy[legacy.length - 1]?.timestamp ?? Date.now();
    this.entries = legacy;
    this.entriesDirty = true;
    this.indexDirty = true;
    this.flush();
    try {
      fs.rmSync(this.legacyFile, { force: true });
    } catch {
      /* leaving it costs nothing; it is never read again */
    }
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
    if (!this.entriesDirty && !this.indexDirty) {
      return;
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (this.entriesDirty && this.index.activeId) {
        const file: SessionFile = {
          version: FORMAT_VERSION,
          id: this.index.activeId,
          entries: this.entries,
        };
        writeAtomic(this.sessionFile(this.index.activeId), JSON.stringify(file));
        this.entriesDirty = false;
      }
      if (this.indexDirty) {
        writeAtomic(path.join(this.dir, 'index.json'), JSON.stringify(this.index));
        this.indexDirty = false;
      }
      this.warned = false;
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        console.warn(
          `[tara] could not save conversation history to ${this.dir}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  dispose(): void {
    this.flush();
  }
}

/**
 * Written beside the target and renamed: a crash or a full disk during the write
 * then leaves the previous content intact instead of half a file.
 */
function writeAtomic(file: string, contents: string) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, file);
}

/** First line, collapsed and cut — enough to recognise a session by. */
function summarise(text: string): string {
  const line = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > MAX_TITLE_CHARS ? `${line.slice(0, MAX_TITLE_CHARS - 1)}…` : line;
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

function isMeta(value: unknown): value is SessionMeta {
  const m = value as SessionMeta | undefined;
  return (
    !!m &&
    typeof m.id === 'string' &&
    typeof m.title === 'string' &&
    typeof m.createdAt === 'number' &&
    typeof m.updatedAt === 'number'
  );
}
