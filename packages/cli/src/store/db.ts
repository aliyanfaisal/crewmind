import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { ContextRecord, type RecordType } from '@crewmind/core';

// Local index (PLAN §5.2). Everything here can be rebuilt from the memory ref with
// `crewmind reindex`, except the outbox, which holds records not yet pushed.

export function dbPath(dataDir: string, projectId: string): string {
  return join(dataDir, 'db', `${projectId}.sqlite`);
}

/** Each entry upgrades the schema by one version (tracked in PRAGMA user_version). */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE records (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    tags TEXT NOT NULL,
    scope TEXT NOT NULL,
    branch TEXT,
    supersedes TEXT,
    author TEXT NOT NULL,
    created_at TEXT NOT NULL,
    json TEXT NOT NULL
  ) STRICT;
  CREATE INDEX records_type ON records(type, created_at);
  CREATE INDEX records_supersedes ON records(supersedes);

  CREATE VIRTUAL TABLE records_fts USING fts5(
    title, body, tags, content='records', content_rowid='rowid'
  );
  CREATE TRIGGER records_ai AFTER INSERT ON records BEGIN
    INSERT INTO records_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
  END;
  CREATE TRIGGER records_ad AFTER DELETE ON records BEGIN
    INSERT INTO records_fts(records_fts, rowid, title, body, tags)
      VALUES ('delete', old.rowid, old.title, old.body, old.tags);
  END;
  CREATE TRIGGER records_au AFTER UPDATE ON records BEGIN
    INSERT INTO records_fts(records_fts, rowid, title, body, tags)
      VALUES ('delete', old.rowid, old.title, old.body, old.tags);
    INSERT INTO records_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
  END;

  CREATE TABLE outbox (
    id TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    branch TEXT,
    head TEXT,
    queued_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE sync_state (
    ref TEXT PRIMARY KEY,
    commit_sha TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  `,
];

export interface OutboxEntry {
  record: ContextRecord;
  /** Branch and local HEAD when the record was approved: the publish-gate anchor (D29). */
  branch: string | null;
  head: string | null;
  queuedAt: string;
}

export interface ListOptions {
  type?: RecordType;
  limit?: number;
}

export class Store {
  private constructor(private readonly db: DatabaseSync) {}

  /** Opens (creating if needed) the index at `path`. Use ':memory:' in tests. */
  static open(path: string): Store {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    // Hooks and the CLI may open the same file at once; wait rather than fail.
    db.exec('PRAGMA busy_timeout = 5000;');
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
    const store = new Store(db);
    store.migrate();
    return store;
  }

  close(): void {
    this.db.close();
  }

  get schemaVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    return row.user_version;
  }

  private migrate(): void {
    const from = this.schemaVersion;
    if (from > MIGRATIONS.length) {
      throw new Error(`index schema v${from} is newer than this crewmind; please upgrade`);
    }
    for (let v = from; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v] as string);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  /** Runs `fn` atomically. Not reentrant. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // --- records -------------------------------------------------------------------------

  /** Inserts or replaces a record. Input is re-validated: the index must only hold valid data. */
  putRecord(input: ContextRecord): void {
    const r = ContextRecord.parse(input);
    this.db
      .prepare(
        `INSERT INTO records (id, type, title, body, tags, scope, branch, supersedes, author, created_at, json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           type = excluded.type, title = excluded.title, body = excluded.body,
           tags = excluded.tags, scope = excluded.scope, branch = excluded.branch,
           supersedes = excluded.supersedes, author = excluded.author,
           created_at = excluded.created_at, json = excluded.json`,
      )
      .run(
        r.id,
        r.type,
        r.title,
        r.body,
        r.tags.join(' '),
        r.scope,
        r.branch ?? null,
        r.supersedes ?? null,
        r.author,
        r.createdAt,
        JSON.stringify(r),
      );
  }

  getRecord(id: string): ContextRecord | null {
    const row = this.db.prepare('SELECT json FROM records WHERE id = ?').get(id);
    return row ? parseRow(row) : null;
  }

  /** Newest first. */
  listRecords(opts: ListOptions = {}): ContextRecord[] {
    const where = opts.type ? 'WHERE type = ?' : '';
    const params: SQLInputValue[] = opts.type ? [opts.type] : [];
    params.push(opts.limit ?? -1);
    return this.db
      .prepare(`SELECT json FROM records ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(parseRow);
  }

  deleteRecord(id: string): void {
    this.db.prepare('DELETE FROM records WHERE id = ?').run(id);
  }

  /** Empties the rebuildable part of the index (records and sync state). Keeps the outbox. */
  clearIndex(): void {
    this.transaction(() => {
      this.db.exec('DELETE FROM records; DELETE FROM sync_state;');
    });
  }

  // --- outbox --------------------------------------------------------------------------

  enqueue(input: ContextRecord, anchor: { branch?: string; head?: string } = {}): void {
    const r = ContextRecord.parse(input);
    this.db
      .prepare('INSERT INTO outbox (id, json, branch, head, queued_at) VALUES (?, ?, ?, ?, ?)')
      .run(
        r.id,
        JSON.stringify(r),
        anchor.branch ?? null,
        anchor.head ?? null,
        new Date().toISOString(),
      );
  }

  /** Oldest first, so records push in the order they were approved. */
  outbox(): OutboxEntry[] {
    return this.db
      .prepare('SELECT json, branch, head, queued_at FROM outbox ORDER BY queued_at, id')
      .all()
      .map((row) => ({
        record: parseRow(row),
        branch: row.branch as string | null,
        head: row.head as string | null,
        queuedAt: row.queued_at as string,
      }));
  }

  dequeue(ids: readonly string[]): void {
    const del = this.db.prepare('DELETE FROM outbox WHERE id = ?');
    this.transaction(() => {
      for (const id of ids) del.run(id);
    });
  }

  // --- sync state ----------------------------------------------------------------------

  /** Last commit of `ref` that has been indexed, or null if never. */
  getSyncState(ref: string): string | null {
    const row = this.db.prepare('SELECT commit_sha FROM sync_state WHERE ref = ?').get(ref);
    return row ? (row.commit_sha as string) : null;
  }

  setSyncState(ref: string, commit: string): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (ref, commit_sha, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(ref) DO UPDATE SET commit_sha = excluded.commit_sha, updated_at = excluded.updated_at`,
      )
      .run(ref, commit, new Date().toISOString());
  }
}

function parseRow(row: Record<string, unknown>): ContextRecord {
  return ContextRecord.parse(JSON.parse(row.json as string));
}
