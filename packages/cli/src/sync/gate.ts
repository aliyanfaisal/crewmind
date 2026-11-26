import { cacheArgs } from '../git/cache.js';
import { GitError, runGit } from '../git/exec.js';
import type { OutboxEntry } from '../store/db.js';

// Publish gate (D29). A queued record is released once the remote copy of its branch holds a
// commit made after the record. Everything here is read-only: `ls-remote` runs in the cache,
// and ancestry checks run in the working repo, which already has the objects it pushed.

export interface GateResult {
  ready: OutboxEntry[];
  held: OutboxEntry[];
}

/**
 * Splits the outbox into records the gate releases and records still waiting.
 * Network failures (from `ls-remote`) propagate as GitError.
 */
export async function applyGate(
  cache: string,
  repoRoot: string,
  entries: readonly OutboxEntry[],
): Promise<GateResult> {
  const result: GateResult = { ready: [], held: [] };
  const tips = new Map<string, string | null>();
  for (const entry of entries) {
    // No branch (detached HEAD, empty repo): nothing to wait for.
    if (!entry.branch) {
      result.ready.push(entry);
      continue;
    }
    if (!tips.has(entry.branch)) tips.set(entry.branch, await remoteTip(cache, entry.branch));
    const tip = tips.get(entry.branch) ?? null;
    const released = tip !== null && (await isReleased(repoRoot, entry, tip));
    (released ? result.ready : result.held).push(entry);
  }
  return result;
}

/** The remote's commit for `branch`, or null if the branch isn't on the remote. */
async function remoteTip(cache: string, branch: string): Promise<string | null> {
  const ref = `refs/heads/${branch}`;
  const out = await runGit([...cacheArgs(cache), 'ls-remote', 'origin', ref]);
  for (const line of out.split('\n')) {
    const [sha, name] = line.split('\t');
    if (name === ref && sha) return sha;
  }
  return null;
}

async function isReleased(repoRoot: string, entry: OutboxEntry, tip: string): Promise<boolean> {
  // Pushed from another machine and not fetched here: we can't tell yet, so keep waiting.
  if (!(await succeeds(repoRoot, ['cat-file', '-e', `${tip}^{commit}`]))) return false;
  if (entry.head) {
    if (entry.head === tip) return false; // the remote has nothing newer than the note
    if (await succeeds(repoRoot, ['merge-base', '--is-ancestor', entry.head, tip])) return true;
  }
  // History was rewritten (amend, rebase) or there was no HEAD: fall back to commit time.
  const since = entry.queuedAt.replace(/\.\d+Z$/, 'Z');
  const newer = await runGit(['rev-list', '-n', '1', `--since=${since}`, tip], { cwd: repoRoot });
  return newer.trim() !== '';
}

/** Runs a yes/no git query: exit 0 is yes, any git failure is no. */
async function succeeds(cwd: string, args: string[]): Promise<boolean> {
  try {
    await runGit(args, { cwd });
    return true;
  } catch (e) {
    if (e instanceof GitError) return false;
    throw e;
  }
}
