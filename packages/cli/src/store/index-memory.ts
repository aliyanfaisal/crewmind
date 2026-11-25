import {
  type ContextRecord,
  parseRecordFile,
  RecordFileError,
  recordIdFromPath,
} from '@crewmind/core';
import { diffCommits, isAncestor, listFiles, MEMORY_REF, readFiles } from '../git/memory.js';
import type { Store } from './db.js';

export interface DroppedFile {
  path: string;
  /** Safe to log: never contains file contents. */
  reason: string;
}

export interface IndexResult {
  mode: 'none' | 'incremental' | 'full';
  added: number;
  removed: number;
  dropped: DroppedFile[];
}

/**
 * Brings the local index up to `head` (the cache's memory ref). Reads only the files changed
 * since the last indexed commit, or everything when there is no usable starting point
 * (first run, rewritten history, `full`). Every file is untrusted: invalid ones are dropped
 * and reported, never stored. The outbox is never touched.
 */
export async function indexMemory(
  gitDir: string,
  store: Store,
  head: string | null,
  opts: { full?: boolean } = {},
): Promise<IndexResult> {
  const result: IndexResult = { mode: 'none', added: 0, removed: 0, dropped: [] };
  const last = store.getSyncState(MEMORY_REF);
  if (!head) return result; // nothing on the remote yet
  if (head === last && !opts.full) return result;

  const incremental = !opts.full && last !== null && (await isAncestor(gitDir, last, head));
  let toRead: string[];
  let toRemove: string[] = [];
  if (incremental) {
    const changes = (await diffCommits(gitDir, last, head)).filter(
      (c) => recordIdFromPath(c.path) !== null,
    );
    toRead = changes.filter((c) => c.status !== 'deleted').map((c) => c.path);
    toRemove = changes.filter((c) => c.status === 'deleted').map((c) => c.path);
  } else {
    toRead = (await listFiles(gitDir, head, 'records/')).filter(
      (p) => recordIdFromPath(p) !== null,
    );
  }

  // Unrecognised paths (other dirs, `.age` files before M6) are skipped silently: they're
  // not records this version understands, not tampering.
  const contents = await readFiles(gitDir, head, toRead);
  const valid: ContextRecord[] = [];
  for (const path of toRead) {
    const content = contents.get(path);
    if (content === undefined) {
      result.dropped.push({ path, reason: 'not a readable file' });
      continue;
    }
    try {
      valid.push(parseRecordFile(path, content));
    } catch (e) {
      const reason = e instanceof RecordFileError ? e.message : 'invalid record';
      result.dropped.push({ path, reason });
    }
  }

  store.transaction(() => {
    if (!incremental) store.clearIndex();
    for (const path of toRemove) store.deleteRecord(recordIdFromPath(path) as string);
    for (const r of valid) store.putRecord(r);
    store.setSyncState(MEMORY_REF, head);
  });
  result.mode = incremental ? 'incremental' : 'full';
  result.added = valid.length;
  result.removed = toRemove.length;
  return result;
}
