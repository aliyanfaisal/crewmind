import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MemberId, type RepoConfig } from '@crewmind/core';
import { CrewmindError } from './errors.js';
import { ensureCache } from './git/cache.js';
import { runGit } from './git/exec.js';
import { findRepoRoot, getRemoteUrl } from './git/repo.js';
import { cachePath, readRepoConfig } from './project.js';
import { dbPath, Store } from './store/db.js';

/**
 * This machine's member id. Pre-M6 it's a random local id; M6 replaces it with the
 * member identity (keys in the OS keychain) created by init/join.
 */
export async function memberId(dataDir: string): Promise<string> {
  const file = join(dataDir, 'config.json');
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    config = parsed as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new CrewmindError(`${file} is not valid JSON. Fix or delete it.`, { cause: e });
    }
  }
  const existing = MemberId.safeParse(config.memberId);
  if (existing.success) return existing.data;
  const id = `m_${randomBytes(6).toString('hex')}`;
  await mkdir(dataDir, { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ ...config, memberId: id }, null, 2)}\n`);
  await rename(tmp, file);
  return id;
}

export interface Workspace {
  repoRoot: string;
  config: RepoConfig;
  remoteUrl: string;
  cache: string;
  store: Store;
}

/** Opens the current repo's Crewmind state. The caller must close `store`. */
export async function openWorkspace(opts: { cwd: string; dataDir: string }): Promise<Workspace> {
  const repoRoot = await findRepoRoot(opts.cwd);
  if (!repoRoot) throw new CrewmindError('Not inside a git repository.');
  const config = await readRepoConfig(repoRoot);
  if (!config) {
    throw new CrewmindError("Crewmind isn't set up in this repository yet. Run: crewmind init");
  }
  const remoteUrl = await getRemoteUrl(repoRoot, config.remote);
  if (!remoteUrl) throw new CrewmindError(`This repository has no "${config.remote}" remote.`);
  const cache = cachePath(opts.dataDir, config.projectId);
  // Follows the working repo if its remote URL changed.
  await ensureCache(cache, remoteUrl);
  const store = Store.open(dbPath(opts.dataDir, config.projectId));
  return { repoRoot, config, remoteUrl, cache, store };
}

/** Current branch and HEAD of the working repo (read-only). Undefined when detached or empty. */
export async function workingHead(repoRoot: string): Promise<{ branch?: string; head?: string }> {
  const tryGit = async (args: string[]) => {
    try {
      return (await runGit(args, { cwd: repoRoot })).trim() || undefined;
    } catch {
      return undefined;
    }
  };
  return {
    branch: await tryGit(['symbolic-ref', '--short', '-q', 'HEAD']),
    head: await tryGit(['rev-parse', '--verify', '-q', 'HEAD']),
  };
}
