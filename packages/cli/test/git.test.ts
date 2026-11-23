import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureCache } from '../src/git/cache.js';
import { GitError, runGit } from '../src/git/exec.js';
import {
  fetchMemory,
  isPushRejected,
  listFiles,
  MEMORY_REF,
  publish,
  readFile,
} from '../src/git/memory.js';
import { writeCommit } from '../src/git/plumbing.js';
import { findRepoRoot, getRemoteUrl } from '../src/git/repo.js';

// Real git processes: Windows runners are ~10x slower than macOS here.
vi.setConfig({ testTimeout: 60_000 });

let dir: string;

beforeEach(async () => {
  // A space in the path catches quoting bugs (and mirrors Windows profile paths).
  dir = await mkdtemp(join(tmpdir(), 'crewmind git '));
});
afterEach(async () => {
  // Windows can briefly hold locks on files a git process just closed.
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** A bare "GitHub" with one commit on main, plus a developer's working clone. */
async function setupRemoteAndClone() {
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  await runGit(['init', '-q', '--bare', '-b', 'main', remote]);
  await runGit(['init', '-q', '-b', 'main', work]);
  await writeFile(join(work, 'README.md'), 'hello\n');
  await runGit(['add', '.'], { cwd: work });
  await runGit(['-c', 'user.name=dev', '-c', 'user.email=dev@invalid', 'commit', '-qm', 'init'], {
    cwd: work,
  });
  await runGit(['remote', 'add', 'origin', remote], { cwd: work });
  await runGit(['push', '-q', '-u', 'origin', 'main'], { cwd: work });
  return { remote, work };
}

const rec = (n: number) => ({ path: `records/r${n}.json`, content: `{"n":${n}}` });

describe('runGit', () => {
  it('passes arguments literally, never through a shell', async () => {
    const out = await runGit(['rev-parse', '--sq-quote', 'a; rm -rf / $(x) `y`']);
    expect(out).toContain('a; rm -rf / $(x) `y`');
  });

  it('throws GitError with the exit code on failure', async () => {
    const err = await runGit(['rev-parse', 'HEAD'], { cwd: dir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).exitCode).not.toBe(0);
  });
});

describe('repo detection (read-only)', () => {
  it('finds the repo root from a subdirectory and reads the remote URL', async () => {
    const { remote, work } = await setupRemoteAndClone();
    await mkdir(join(work, 'src', 'deep'), { recursive: true });
    const root = await findRepoRoot(join(work, 'src', 'deep'));
    expect(root).not.toBeNull();
    expect(await getRemoteUrl(root as string)).toBe(remote);
  });

  it('returns null outside a repo or without the remote', async () => {
    expect(await findRepoRoot(dir)).toBeNull();
    const { work } = await setupRemoteAndClone();
    expect(await getRemoteUrl(work, 'upstream')).toBeNull();
  });
});

describe('bare cache', () => {
  it('is created once and follows remote URL changes', async () => {
    const cache = join(dir, 'home', '.crewmind', 'repos', 'p1.git');
    await ensureCache(cache, 'https://example.invalid/a.git');
    await ensureCache(cache, 'https://example.invalid/b.git');
    const url = await runGit(['--git-dir', cache, 'remote', 'get-url', 'origin']);
    expect(url.trim()).toBe('https://example.invalid/b.git');
  });
});

describe('writeCommit', () => {
  it('builds nested files on top of the parent without a checkout', async () => {
    const cache = join(dir, 'c.git');
    await ensureCache(cache, 'unused');
    const c1 = await writeCommit(cache, { files: [rec(1)], message: 'one' });
    const c2 = await writeCommit(cache, { parent: c1, files: [rec(2)], message: 'two' });
    expect(await listFiles(cache, c2, 'records/')).toEqual(['records/r1.json', 'records/r2.json']);
    expect(await readFile(cache, c2, 'records/r2.json')).toBe('{"n":2}');
    const author = await runGit(['--git-dir', cache, 'log', '-1', '--format=%an <%ae>', c2]);
    expect(author.trim()).toBe('Crewmind <crewmind@localhost>');
  });
});

describe('publish and fetch', () => {
  it('round-trips records between two machines', async () => {
    const { remote } = await setupRemoteAndClone();
    const pc1 = join(dir, 'pc1.git');
    const pc2 = join(dir, 'pc2.git');
    await ensureCache(pc1, remote);
    await ensureCache(pc2, remote);

    expect(await fetchMemory(pc2)).toBeNull(); // nothing published yet
    await publish(pc1, [rec(1)]);
    const head = await fetchMemory(pc2);
    expect(head).not.toBeNull();
    expect(await readFile(pc2, head as string, 'records/r1.json')).toBe('{"n":1}');
  });

  it('recognises a stale push as a lost race, not a failure', async () => {
    const { remote } = await setupRemoteAndClone();
    const pc1 = join(dir, 'pc1.git');
    const pc2 = join(dir, 'pc2.git');
    await ensureCache(pc1, remote);
    await ensureCache(pc2, remote);
    await publish(pc1, [rec(1)]);
    // pc2 builds on an empty history while the remote already has pc1's commit.
    const stale = await writeCommit(pc2, { files: [rec(2)], message: 'stale' });
    const err = await runGit([
      '--git-dir',
      pc2,
      'push',
      '--porcelain',
      'origin',
      `${stale}:${MEMORY_REF}`,
    ]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect(isPushRejected(err as GitError)).toBe(true);
    // publish() recovers from the same situation.
    await publish(pc2, [rec(2)]);
    const head = await fetchMemory(pc1);
    expect(await listFiles(pc1, head as string, 'records/')).toEqual([
      'records/r1.json',
      'records/r2.json',
    ]);
  });

  it('loses nothing when three machines race', async () => {
    const { remote } = await setupRemoteAndClone();
    const pcs = [join(dir, 'pc1.git'), join(dir, 'pc2.git'), join(dir, 'pc3.git')];
    for (const pc of pcs) await ensureCache(pc, remote);

    await Promise.all(
      pcs.map(async (pc, i) => {
        for (let k = 0; k < 3; k++) {
          await publish(pc, [rec(i * 3 + k)], { retries: 20, baseDelayMs: 5 });
        }
      }),
    );

    const head = await fetchMemory(pcs[0] as string);
    const expected = Array.from({ length: 9 }, (_, n) => `records/r${n}.json`).sort();
    expect(await listFiles(pcs[0] as string, head as string, 'records/')).toEqual(expected);
  });

  it("never touches the developer's working repo", async () => {
    const { remote, work } = await setupRemoteAndClone();
    const before = await runGit(['for-each-ref'], { cwd: work });
    const cache = join(dir, 'pc1.git');
    await ensureCache(cache, remote);
    await publish(cache, [rec(1)]);

    expect(await runGit(['for-each-ref'], { cwd: work })).toBe(before);
    expect(await runGit(['status', '--porcelain'], { cwd: work })).toBe('');
    await runGit(['pull', '-q'], { cwd: work });
    expect(await runGit(['for-each-ref', 'refs/crewmind'], { cwd: work })).toBe('');
    // The remote has it, under the hidden ref only.
    const remoteRefs = await runGit(['ls-remote', remote]);
    expect(remoteRefs).toContain(MEMORY_REF);
    expect(await runGit(['ls-remote', '--heads', remote])).not.toContain('crewmind');
  });

  it('fails with GitError when the remote is unreachable', async () => {
    const cache = join(dir, 'pc1.git');
    await ensureCache(cache, join(dir, 'does-not-exist.git'));
    await expect(publish(cache, [rec(1)])).rejects.toBeInstanceOf(GitError);
  });
});
