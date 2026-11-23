import { cacheArgs } from './cache.js';
import { GitError, runGit } from './exec.js';
import { type MemoryFile, writeCommit } from './plumbing.js';

export const MEMORY_REF = 'refs/crewmind/memory';
// One pattern refspec: it fetches memory and all activity refs, and it doesn't fail
// when the remote has no Crewmind refs yet.
const FETCH_REFSPEC = '+refs/crewmind/*:refs/crewmind/*';

/** Fetches all Crewmind refs into the cache. Returns the memory head, or null if none exists. */
export async function fetchMemory(gitDir: string): Promise<string | null> {
  await runGit([...cacheArgs(gitDir), 'fetch', '-q', '--prune', 'origin', FETCH_REFSPEC]);
  return resolveRef(gitDir, MEMORY_REF);
}

async function resolveRef(gitDir: string, ref: string): Promise<string | null> {
  try {
    return (
      await runGit([...cacheArgs(gitDir), 'rev-parse', '--verify', '-q', `${ref}^{commit}`])
    ).trim();
  } catch (e) {
    if (e instanceof GitError && e.exitCode === 1) return null;
    throw e;
  }
}

/** Paths under `prefix` in `commit`, sorted. */
export async function listFiles(gitDir: string, commit: string, prefix = ''): Promise<string[]> {
  const out = await runGit([...cacheArgs(gitDir), 'ls-tree', '-r', '--name-only', commit]);
  return out
    .split('\n')
    .filter((p) => p !== '' && p.startsWith(prefix))
    .sort();
}

export function readFile(gitDir: string, commit: string, path: string): Promise<string> {
  return runGit([...cacheArgs(gitDir), 'cat-file', 'blob', `${commit}:${path}`]);
}

export interface PublishOptions {
  retries?: number;
  baseDelayMs?: number;
}

/**
 * Adds `files` to the remote memory ref. Never forces: when someone else pushed first,
 * it fetches, rebuilds the same files on the new head and tries again with backoff.
 * Record files have unique names, so rebuilding can't conflict.
 */
export async function publish(
  gitDir: string,
  files: readonly MemoryFile[],
  opts: PublishOptions = {},
): Promise<string> {
  const retries = opts.retries ?? 5;
  const baseDelay = opts.baseDelayMs ?? 200;
  const message = `crewmind: ${files.length} file${files.length === 1 ? '' : 's'} [skip ci]`;

  for (let attempt = 0; ; attempt++) {
    const parent = await fetchMemory(gitDir);
    const commit = await writeCommit(gitDir, { parent: parent ?? undefined, files, message });
    try {
      await pushMemory(gitDir, commit);
      return commit;
    } catch (e) {
      if (!(e instanceof GitError) || !isPushRejected(e) || attempt >= retries) throw e;
      const jitter = Math.random() * baseDelay;
      await new Promise((r) => setTimeout(r, baseDelay * 2 ** attempt + jitter));
    }
  }
}

/**
 * Fast-forward-only push of `commit` to the remote memory ref, then records it locally.
 * Throws a GitError that `isPushRejected` recognises when someone else pushed first.
 */
export async function pushMemory(gitDir: string, commit: string): Promise<void> {
  await runGit([...cacheArgs(gitDir), 'push', '--porcelain', 'origin', `${commit}:${MEMORY_REF}`]);
  await runGit([...cacheArgs(gitDir), 'update-ref', MEMORY_REF, commit]);
}

/** True when the push lost a race (non-fast-forward), as opposed to a network or auth failure. */
export function isPushRejected(e: GitError): boolean {
  const lines = `${e.stdout}\n${e.stderr}`;
  return (
    /^!\s.*\[(rejected|remote rejected)\]/m.test(lines) &&
    /fetch first|non-fast-forward|cannot lock ref|failed to update ref/.test(lines)
  );
}
