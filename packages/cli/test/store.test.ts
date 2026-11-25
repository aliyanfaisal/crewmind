import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type ContextRecord, newId } from '@crewmind/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dbPath, Store } from '../src/store/db.js';

function rec(over: Partial<ContextRecord> = {}): ContextRecord {
  return {
    id: newId(),
    type: 'decision',
    title: 'Use Postgres advisory locks for the job queue',
    body: 'We picked advisory locks over SKIP LOCKED because the queue table is tiny.',
    tags: ['queue'],
    files: ['src/jobs/'],
    scope: 'project',
    source: 'cli',
    author: 'm_abc123',
    createdAt: '2026-11-25T10:00:00.000Z',
    scanner: 'v1',
    ...over,
  };
}

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => {
  store.close();
});

describe('records', () => {
  it('round-trips a record', () => {
    const r = rec();
    store.putRecord(r);
    expect(store.getRecord(r.id)).toEqual(r);
    expect(store.getRecord(newId())).toBeNull();
  });

  it('upserts without duplicating', () => {
    const r = rec();
    store.putRecord(r);
    store.putRecord({ ...r, title: 'Changed title' });
    expect(store.listRecords()).toHaveLength(1);
    expect(store.getRecord(r.id)?.title).toBe('Changed title');
  });

  it('rejects invalid records', () => {
    expect(() => store.putRecord(rec({ body: 'too short' }))).toThrow();
    expect(() => store.putRecord({ ...rec(), extra: 1 } as ContextRecord)).toThrow();
    expect(store.listRecords()).toHaveLength(0);
  });

  it('lists newest first and filters by type', () => {
    const a = rec({ createdAt: '2026-11-01T00:00:00.000Z' });
    const b = rec({ type: 'note', createdAt: '2026-11-03T00:00:00.000Z' });
    const c = rec({ createdAt: '2026-11-02T00:00:00.000Z' });
    for (const r of [a, b, c]) store.putRecord(r);
    expect(store.listRecords().map((r) => r.id)).toEqual([b.id, c.id, a.id]);
    expect(store.listRecords({ type: 'decision' }).map((r) => r.id)).toEqual([c.id, a.id]);
    expect(store.listRecords({ limit: 1 }).map((r) => r.id)).toEqual([b.id]);
  });

  it('keeps the full-text index in sync on insert, update and delete', () => {
    // Search lands in M4; here we only check the FTS table follows the records table.
    const path = join(tmpdir(), `crewmind-fts-${newId()}.sqlite`);
    const s = Store.open(path);
    const r = rec();
    s.putRecord(r);
    s.putRecord({ ...r, title: 'Use Redis streams instead' });
    const other = rec({ title: 'Advisory locks are fine' });
    s.putRecord(other);
    s.deleteRecord(other.id);
    s.close();

    const db = new DatabaseSync(path);
    const hits = (q: string) =>
      db.prepare('SELECT count(*) AS n FROM records_fts WHERE records_fts MATCH ?').get(q)?.n;
    expect(hits('redis')).toBe(1);
    expect(hits('title:advisory')).toBe(0);
    expect(hits('skip')).toBe(1);
    db.close();
  });

  it('clearIndex empties records and sync state but keeps the outbox', () => {
    store.putRecord(rec());
    store.setSyncState('refs/crewmind/memory', 'abc1234');
    store.enqueue(rec());
    store.clearIndex();
    expect(store.listRecords()).toHaveLength(0);
    expect(store.getSyncState('refs/crewmind/memory')).toBeNull();
    expect(store.outbox()).toHaveLength(1);
  });
});

describe('outbox', () => {
  it('queues in order with the publish-gate anchor and dequeues', () => {
    const a = rec();
    const b = rec();
    store.enqueue(a, { branch: 'feat/x', head: 'abc1234' });
    store.enqueue(b);
    const box = store.outbox();
    expect(box.map((e) => e.record.id)).toEqual([a.id, b.id]);
    expect(box[0]).toMatchObject({ record: a, branch: 'feat/x', head: 'abc1234' });
    expect(box[1]).toMatchObject({ branch: null, head: null });
    store.dequeue([a.id]);
    expect(store.outbox().map((e) => e.record.id)).toEqual([b.id]);
  });

  it('refuses to queue the same record twice', () => {
    const r = rec();
    store.enqueue(r);
    expect(() => store.enqueue(r)).toThrow();
  });
});

describe('sync state', () => {
  it('stores the last indexed commit per ref', () => {
    expect(store.getSyncState('refs/crewmind/memory')).toBeNull();
    store.setSyncState('refs/crewmind/memory', 'abc1234');
    store.setSyncState('refs/crewmind/memory', 'def5678');
    store.setSyncState('refs/crewmind/activity/m_abc123', '1234abc');
    expect(store.getSyncState('refs/crewmind/memory')).toBe('def5678');
    expect(store.getSyncState('refs/crewmind/activity/m_abc123')).toBe('1234abc');
  });
});

describe('on disk', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crewmind store '));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('creates the db under dataDir/db and persists across opens', () => {
    const path = dbPath(dir, 'p_test');
    expect(path).toBe(join(dir, 'db', 'p_test.sqlite'));
    const r = rec();
    const s1 = Store.open(path);
    s1.putRecord(r);
    s1.enqueue(rec());
    s1.close();
    const s2 = Store.open(path);
    expect(s2.schemaVersion).toBe(1);
    expect(s2.getRecord(r.id)).toEqual(r);
    expect(s2.outbox()).toHaveLength(1);
    s2.close();
  });

  it('refuses an index from a newer crewmind', () => {
    const path = dbPath(dir, 'p_test');
    Store.open(path).close();
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version = 99');
    db.close();
    expect(() => Store.open(path)).toThrow(/newer/);
  });

  it('rolls back a failed transaction', () => {
    const s = Store.open(dbPath(dir, 'p_test'));
    const r = rec();
    expect(() =>
      s.transaction(() => {
        s.putRecord(r);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(s.getRecord(r.id)).toBeNull();
    s.close();
  });
});
