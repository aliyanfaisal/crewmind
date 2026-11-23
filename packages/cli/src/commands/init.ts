import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalize, MANIFEST_FORMAT, newProjectId, ProjectManifest } from '@crewmind/core';
import { CrewmindError } from '../errors.js';
import { ensureCache } from '../git/cache.js';
import { GitError } from '../git/exec.js';
import { fetchMemory, isPushRejected, pushMemory, readFile } from '../git/memory.js';
import { writeCommit } from '../git/plumbing.js';
import { findRepoRoot, getRemoteUrl } from '../git/repo.js';
import {
  addToExclude,
  CONFIG_DIR,
  cachePath,
  readRepoConfig,
  writeRepoConfig,
} from '../project.js';

export interface InitOptions {
  cwd: string;
  /** Usually ~/.crewmind. */
  dataDir: string;
  remote?: string;
}

export interface InitResult {
  status: 'created' | 'joined' | 'already';
  projectId: string;
  remote: string;
  remoteUrl: string;
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const remote = opts.remote ?? 'origin';
  const repoRoot = await findRepoRoot(opts.cwd);
  if (!repoRoot) {
    throw new CrewmindError('Not inside a git repository. Run this from your project folder.');
  }
  const remoteUrl = await getRemoteUrl(repoRoot, remote);
  if (!remoteUrl) {
    throw new CrewmindError(
      `This repository has no "${remote}" remote. Add one with: git remote add ${remote} <url>`,
    );
  }

  const existing = await readRepoConfig(repoRoot);
  if (existing) {
    await ensureCache(cachePath(opts.dataDir, existing.projectId), remoteUrl);
    return { status: 'already', projectId: existing.projectId, remote, remoteUrl };
  }

  // The cache is named after the project id, which we only learn from the remote.
  // Discover it in a temporary cache, then move that into place.
  const pending = join(opts.dataDir, 'repos', `pending-${randomBytes(6).toString('hex')}.git`);
  try {
    await ensureCache(pending, remoteUrl);
    const { manifest, created } = await createOrReadManifest(pending, remote, remoteUrl);
    const cache = cachePath(opts.dataDir, manifest.projectId);
    if (existsSync(cache)) {
      await ensureCache(cache, remoteUrl);
      await fetchMemory(cache);
    } else {
      await rename(pending, cache);
    }
    await writeRepoConfig(repoRoot, { projectId: manifest.projectId, remote });
    await addToExclude(repoRoot, `${CONFIG_DIR}/`);
    return {
      status: created ? 'created' : 'joined',
      projectId: manifest.projectId,
      remote,
      remoteUrl,
    };
  } finally {
    await rm(pending, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** Reads the remote's crewmind.json, or creates it. Two machines racing end up with one. */
async function createOrReadManifest(
  gitDir: string,
  remote: string,
  remoteUrl: string,
): Promise<{ manifest: ProjectManifest; created: boolean }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const head = await reach(() => fetchMemory(gitDir), remote, remoteUrl);
    if (head) return { manifest: await readManifest(gitDir, head), created: false };

    const manifest: ProjectManifest = {
      format: MANIFEST_FORMAT,
      projectId: newProjectId(),
      encryption: false, // Plaintext until M6.
      createdAt: new Date().toISOString(),
    };
    const commit = await writeCommit(gitDir, {
      files: [{ path: 'crewmind.json', content: `${canonicalize(manifest)}\n` }],
      message: 'crewmind: create memory [skip ci]',
    });
    try {
      await reach(() => pushMemory(gitDir, commit), remote, remoteUrl);
      return { manifest, created: true };
    } catch (e) {
      // Someone created it first: loop and adopt theirs.
      if (!(e instanceof CrewmindError && e.cause instanceof GitError && isPushRejected(e.cause))) {
        throw e;
      }
    }
  }
  throw new CrewmindError('Could not create team memory: the remote kept changing. Try again.');
}

async function readManifest(gitDir: string, head: string): Promise<ProjectManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(gitDir, head, 'crewmind.json'));
  } catch {
    parsed = undefined;
  }
  const result = ProjectManifest.safeParse(parsed);
  if (!result.success) {
    throw new CrewmindError(
      'The team memory on this remote is missing crewmind.json or uses a newer format. Update crewmind and try again.',
    );
  }
  return result.data;
}

/** Turns network and auth failures into a message the user can act on. */
async function reach<T>(fn: () => Promise<T>, remote: string, remoteUrl: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    if (isPushRejected(e)) throw new CrewmindError('Push rejected.', { cause: e });
    const detail = e.stderr.trim().split('\n')[0] ?? '';
    throw new CrewmindError(
      `Could not reach "${remote}" (${remoteUrl}). Check that \`git fetch ${remote}\` works. ${detail}`.trim(),
      { cause: e },
    );
  }
}
