import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectManifest } from '@crewmind/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../src/commands/init.js';
import { CrewmindError } from '../src/errors.js';
import { runGit } from '../src/git/exec.js';
import { MEMORY_REF } from '../src/git/memory.js';
import { writeCommit } from '../src/git/plumbing.js';

vi.setConfig({ testTimeout: 60_000 });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crewmind init '));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** A bare "GitHub" with one commit on main. */
async function makeRemote() {
  const remote = join(dir, 'remote.git');
  const seed = join(dir, 'seed');
  await runGit(['init', '-q', '--bare', '-b', 'main', remote]);
  await runGit(['init', '-q', '-b', 'main', seed]);
  await writeFile(join(seed, 'README.md'), 'hi\n');
  await runGit(['add', '.'], { cwd: seed });
  await runGit(['-c', 'user.name=d', '-c', 'user.email=d@invalid', 'commit', '-qm', 'init'], {
    cwd: seed,
  });
  await runGit(['push', '-q', remote, 'main'], { cwd: seed });
  return remote;
}

/** A developer machine: its own clone and its own ~/.crewmind. */
async function machine(name: string, remote: string) {
  const work = join(dir, name, 'project');
  await runGit(['clone', '-q', remote, work]);
  return { cwd: work, dataDir: join(dir, name, '.crewmind') };
}

describe('crewmind init', () => {
  it('refuses to run outside a git repository', async () => {
    await expect(runInit({ cwd: dir, dataDir: join(dir, 'd') })).rejects.toThrow(/git repository/);
  });

  it('explains a missing remote', async () => {
    const work = join(dir, 'solo');
    await runGit(['init', '-q', work]);
    await expect(runInit({ cwd: work, dataDir: join(dir, 'd') })).rejects.toThrow(
      /"origin" remote/,
    );
  });

  it('creates team memory on first run without touching the working tree', async () => {
    const remote = await makeRemote();
    const pc1 = await machine('pc1', remote);
    const refsBefore = await runGit(['for-each-ref'], { cwd: pc1.cwd });

    const result = await runInit(pc1);
    expect(result.status).toBe('created');

    // Manifest is on the hidden ref and valid.
    const manifest = await runGit([
      '--git-dir',
      remote,
      'cat-file',
      'blob',
      `${MEMORY_REF}:crewmind.json`,
    ]);
    expect(ProjectManifest.parse(JSON.parse(manifest)).projectId).toBe(result.projectId);
    // Local config exists, is git-excluded, and the cache is keyed by project id.
    const config = JSON.parse(await readFile(join(pc1.cwd, '.crewmind', 'config.json'), 'utf8'));
    expect(config).toEqual({ projectId: result.projectId, remote: 'origin' });
    expect(existsSync(join(pc1.dataDir, 'repos', `${result.projectId}.git`, 'HEAD'))).toBe(true);
    expect(await runGit(['status', '--porcelain'], { cwd: pc1.cwd })).toBe('');
    expect(await runGit(['for-each-ref'], { cwd: pc1.cwd })).toBe(refsBefore);
  });

  it('joins existing memory on a second machine and is idempotent', async () => {
    const remote = await makeRemote();
    const pc1 = await machine('pc1', remote);
    const pc2 = await machine('pc2', remote);
    const created = await runInit(pc1);

    const joined = await runInit(pc2);
    expect(joined).toMatchObject({ status: 'joined', projectId: created.projectId });

    const again = await runInit(pc2);
    expect(again).toMatchObject({ status: 'already', projectId: created.projectId });
    const exclude = await readFile(join(pc2.cwd, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((l) => l === '.crewmind/')).toHaveLength(1);
  });

  it('ends with one project when two machines init at the same time', async () => {
    const remote = await makeRemote();
    const pcs = await Promise.all(['pc1', 'pc2', 'pc3'].map((n) => machine(n, remote)));
    const results = await Promise.all(pcs.map((pc) => runInit(pc)));
    const ids = new Set(results.map((r) => r.projectId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.status === 'created')).toHaveLength(1);
  });

  it('rejects an invalid manifest and writes nothing locally', async () => {
    const remote = await makeRemote();
    const bad = await writeCommit(remote, {
      files: [{ path: 'crewmind.json', content: '{"format":99}' }],
      message: 'bad',
    });
    await runGit(['--git-dir', remote, 'update-ref', MEMORY_REF, bad]);
    const pc1 = await machine('pc1', remote);

    const err = await runInit(pc1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrewmindError);
    expect(existsSync(join(pc1.cwd, '.crewmind'))).toBe(false);
  });
});
