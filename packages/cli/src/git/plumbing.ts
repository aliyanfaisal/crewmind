import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cacheArgs } from './cache.js';
import { runGit } from './exec.js';

export interface MemoryFile {
  /** Repo-relative path inside the memory tree, e.g. `records/<ulid>.age`. */
  path: string;
  content: string;
}

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Crewmind',
  GIT_AUTHOR_EMAIL: 'crewmind@localhost',
  GIT_COMMITTER_NAME: 'Crewmind',
  GIT_COMMITTER_EMAIL: 'crewmind@localhost',
};

/**
 * Writes a commit containing `parent`'s tree plus `files`, using a temporary index.
 * No checkout and no ref update: the caller decides where the commit goes.
 */
export async function writeCommit(
  gitDir: string,
  opts: { parent?: string; files: readonly MemoryFile[]; message: string },
): Promise<string> {
  const git = cacheArgs(gitDir);
  const index = join(gitDir, `crewmind-index-${randomBytes(6).toString('hex')}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    if (opts.parent) await runGit([...git, 'read-tree', opts.parent], { env });
    for (const file of opts.files) {
      const blob = (
        await runGit([...git, 'hash-object', '-w', '--stdin'], { input: file.content })
      ).trim();
      await runGit(
        [...git, 'update-index', '--add', '--cacheinfo', `100644,${blob},${file.path}`],
        { env },
      );
    }
    const tree = (await runGit([...git, 'write-tree'], { env })).trim();
    const parentArgs = opts.parent ? ['-p', opts.parent] : [];
    const commit = await runGit([...git, 'commit-tree', '--no-gpg-sign', tree, ...parentArgs], {
      input: opts.message,
      env: IDENTITY,
    });
    return commit.trim();
  } finally {
    await rm(index, { force: true });
  }
}
