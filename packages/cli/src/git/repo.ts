import { GitError, runGit } from './exec.js';

// Read-only queries against the developer's working repo. Nothing here may write to it.

/** The top-level directory of the repo containing `cwd`, or null when not in a repo. */
export async function findRepoRoot(cwd: string): Promise<string | null> {
  try {
    return (await runGit(['rev-parse', '--show-toplevel'], { cwd })).trim() || null;
  } catch (e) {
    if (e instanceof GitError) return null;
    throw e;
  }
}

/** The URL of `remote` in the repo at `repoRoot`, or null when it isn't configured. */
export async function getRemoteUrl(repoRoot: string, remote = 'origin'): Promise<string | null> {
  try {
    return (await runGit(['remote', 'get-url', remote], { cwd: repoRoot })).trim() || null;
  } catch (e) {
    if (e instanceof GitError) return null;
    throw e;
  }
}
