import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ContextRecord, newId, recordPath } from '@crewmind/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheArgs } from '../src/git/cache.js';
import { runGit } from '../src/git/exec.js';
import { MEMORY_REF } from '../src/git/memory.js';
import { type MemoryFile, writeCommit } from '../src/git/plumbing.js';
import { Store } from '../src/store/db.js';
import { indexMemory } from '../src/store/index-memory.js';

vi.setConfig({ testTimeout: 60_000 });

let dir: string;
let cache: string;
let store: Store;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crewmind index '));
  cache = join(dir, 'cache.git');
  await runGit(['init', '-q', '--bare', cache]);
  store = Store.open(':memory:');
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function rec(over: Partial<ContextRecord> = {}): ContextRecord {
  return {
    id: newId(),
    type: 'decision',
    title: 'Use advisory locks for the job queue',
    body: 'Advisory locks over SKIP LOCKED because the queue table is tiny and contention is low.',
    tags: [],
    files: [],
    scope: 'project',
    source: 'cli',
    author: 'm_abc123',
    createdAt: '2026-11-25T10:00:00.000Z',
    scanner: 'v1',
    ...over,
  };
}

const fileFor = (r: ContextRecord): MemoryFile => ({
  path: recordPath(r.id),
  content: JSON.stringify({ v: 1, record: r }),
});

/** Appends a commit with `files` to the cache's memory ref and returns the new head. */
async function commit(files: MemoryFile[], parent?: string): Promise<string> {
  const sha = await writeCommit(cache, { parent, files, message: 'test' });
  await runGit([...cacheArgs(cache), 'update-ref', MEMORY_REF, sha]);
  return sha;
}

const ids = () =>
  store
    .listRecords()
    .map((r) => r.id)
    .sort();

describe('indexMemory', () => {
  it('does nothing when there is no memory yet', async () => {
    const res = await indexMemory(cache, store, null);
    expect(res).toMatchObject({ mode: 'none', added: 0 });
    expect(store.getSyncState(MEMORY_REF)).toBeNull();
  });

  it('indexes everything on first run and records the head', async () => {
    const a = rec();
    const b = rec();
    const head = await commit([{ path: 'crewmind.json', content: '{}' }, fileFor(a), fileFor(b)]);
    const res = await indexMemory(cache, store, head);
    expect(res).toMatchObject({ mode: 'full', added: 2, dropped: [] });
    expect(ids()).toEqual([a.id, b.id].sort());
    expect(store.getSyncState(MEMORY_REF)).toBe(head);
  });

  it('only reads files added since the last indexed commit', async () => {
    const a = rec();
    const h1 = await commit([fileFor(a)]);
    await indexMemory(cache, store, h1);

    const b = rec();
    const c = rec();
    const h2 = await commit([fileFor(b)], h1);
    const h3 = await commit([fileFor(c)], h2);
    const res = await indexMemory(cache, store, h3);
    expect(res).toMatchObject({ mode: 'incremental', added: 2 });
    expect(ids()).toEqual([a.id, b.id, c.id].sort());
    expect(store.getSyncState(MEMORY_REF)).toBe(h3);
  });

  it('is a no-op when already up to date', async () => {
    const head = await commit([fileFor(rec())]);
    await indexMemory(cache, store, head);
    expect(await indexMemory(cache, store, head)).toMatchObject({ mode: 'none', added: 0 });
  });

  it('drops invalid files without failing the rest, and never stores them', async () => {
    const good = rec();
    const mismatched = rec();
    const head = await commit([
      fileFor(good),
      { path: recordPath(newId()), content: '{ nope' },
      { path: recordPath(newId()), content: JSON.stringify({ v: 1, record: { title: 'x' } }) },
      // Valid record stored under another record's name.
      { path: recordPath(newId()), content: JSON.stringify({ v: 1, record: mismatched }) },
      { path: 'records/README.md', content: 'ignored, not a record path' },
    ]);
    const res = await indexMemory(cache, store, head);
    expect(res.added).toBe(1);
    expect(res.dropped).toHaveLength(3);
    // Reasons must not echo file contents (rule 8: never log record bodies).
    for (const d of res.dropped) expect(d.reason).not.toContain('nope');
    expect(ids()).toEqual([good.id]);
  });

  it('removes records whose files were deleted from the ref', async () => {
    const a = rec();
    const b = rec();
    const h1 = await commit([fileFor(a), fileFor(b)]);
    await indexMemory(cache, store, h1);
    // A child of h1 whose tree holds only a (writeCommit can only add files).
    const onlyA = await writeCommit(cache, { files: [fileFor(a)], message: 'x' });
    const h2 = (
      await runGit([...cacheArgs(cache), 'commit-tree', `${onlyA}^{tree}`, '-p', h1], {
        input: 'rm b',
      })
    ).trim();
    const res = await indexMemory(cache, store, h2);
    expect(res).toMatchObject({ mode: 'incremental', removed: 1 });
    expect(ids()).toEqual([a.id]);
  });

  it('rebuilds from scratch when history was rewritten (last commit not an ancestor)', async () => {
    const stale = rec();
    await indexMemory(cache, store, await commit([fileFor(stale)]));
    const fresh = rec();
    const other = await commit([fileFor(fresh)]); // unrelated root
    const res = await indexMemory(cache, store, other);
    expect(res.mode).toBe('full');
    expect(ids()).toEqual([fresh.id]);
  });

  it('rebuilds when the last indexed commit is unknown to the cache', async () => {
    store.setSyncState(MEMORY_REF, 'f'.repeat(40));
    const a = rec();
    const res = await indexMemory(cache, store, await commit([fileFor(a)]));
    expect(res.mode).toBe('full');
    expect(ids()).toEqual([a.id]);
  });

  it('full reindex keeps the outbox', async () => {
    const queued = rec();
    store.enqueue(queued);
    await indexMemory(cache, store, await commit([fileFor(rec())]), { full: true });
    expect(store.outbox().map((e) => e.record.id)).toEqual([queued.id]);
  });

  it('handles many records in one pass', async () => {
    const many = Array.from({ length: 150 }, () => rec());
    const res = await indexMemory(cache, store, await commit(many.map(fileFor)));
    expect(res.added).toBe(150);
  });
});
