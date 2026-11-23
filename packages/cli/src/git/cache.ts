import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runGit } from './exec.js';

/** Arguments that run git against a bare cache with the user's hooks disabled. */
export function cacheArgs(gitDir: string): string[] {
  // A global core.hooksPath (husky etc.) would otherwise run on our pushes.
  return ['--git-dir', gitDir, '-c', `core.hooksPath=${join(gitDir, 'no-hooks')}`];
}

/**
 * Creates the bare cache at `gitDir` (e.g. ~/.crewmind/repos/<id>.git) if needed and points
 * its `origin` at `remoteUrl`. All Crewmind git work happens here, never in the working repo.
 */
export async function ensureCache(gitDir: string, remoteUrl: string): Promise<void> {
  if (!existsSync(join(gitDir, 'HEAD'))) {
    await mkdir(dirname(gitDir), { recursive: true });
    await runGit(['init', '-q', '--bare', gitDir]);
    await runGit([...cacheArgs(gitDir), 'config', 'gc.auto', '0']);
    await runGit([...cacheArgs(gitDir), 'remote', 'add', 'origin', remoteUrl]);
    return;
  }
  await runGit([...cacheArgs(gitDir), 'remote', 'set-url', 'origin', remoteUrl]);
}
