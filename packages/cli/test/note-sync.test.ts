import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../src/commands/init.js';
import { runNote } from '../src/commands/note.js';
import { runSync } from '../src/commands/sync.js';
import { CrewmindError } from '../src/errors.js';
import { runGit } from '../src/git/exec.js';
import { MEMORY_REF } from '../src/git/memory.js';
import { dbPath, Store } from '../src/store/db.js';

vi.setConfig({ testTimeout: 60_000 });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crewmind sync '));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const WHY =
  'Use advisory locks for the job queue because the table is tiny and SKIP LOCKED adds noise.';

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

async function machine(name: string, remote: string) {
  const cwd = join(dir, name, 'project');
  await runGit(['clone', '-q', remote, cwd]);
  const pc = { cwd, dataDir: join(dir, name, '.crewmind') };
  const { projectId } = await runInit(pc);
  return { ...pc, projectId };
}

function records(pc: { dataDir: string; projectId: string }) {
  const store = Store.open(dbPath(pc.dataDir, pc.projectId));
  try {
    return store.listRecords();
  } finally {
    store.close();
  }
}

function outbox(pc: { dataDir: string; projectId: string }) {
  const store = Store.open(dbPath(pc.dataDir, pc.projectId));
  try {
    return store.outbox();
  } finally {
    store.close();
  }
}

describe('crewmind note', () => {
  it('queues a valid record anchored to the branch and HEAD, without touching the repo', async () => {
    const pc1 = await machine('pc1', await makeRemote());
    const head = (await runGit(['rev-parse', 'HEAD'], { cwd: pc1.cwd })).trim();
    const refsBefore = await runGit(['for-each-ref'], { cwd: pc1.cwd });

    const r = await runNote({ ...pc1, text: WHY, type: 'decision', files: ['src\\jobs\\'] });
    expect(r.record).toMatchObject({
      type: 'decision',
      body: WHY,
      files: ['src/jobs/'],
      scope: 'project',
      source: 'cli',
      commit: head,
    });
    expect(r.record.title.length).toBeLessThanOrEqual(80);
    expect(r.record.author).toMatch(/^m_[a-z0-9]+$/);
    expect(outbox(pc1)).toMatchObject([{ branch: 'main', head }]);
    expect(await runGit(['status', '--porcelain'], { cwd: pc1.cwd })).toBe('');
    expect(await runGit(['for-each-ref'], { cwd: pc1.cwd })).toBe(refsBefore);
  });

  it('keeps the same member id across notes', async () => {
    const pc1 = await machine('pc1', await makeRemote());
    const a = await runNote({ ...pc1, text: WHY });
    const b = await runNote({ ...pc1, text: WHY });
    expect(a.record.author).toBe(b.record.author);
    const cfg = JSON.parse(await readFile(join(pc1.dataDir, 'config.json'), 'utf8'));
    expect(cfg.memberId).toBe(a.record.author);
  });

  it('explains notes that are too short or invalid', async () => {
    const pc1 = await machine('pc1', await makeRemote());
    await expect(runNote({ ...pc1, text: 'use redis' })).rejects.toThrow(/at least 40/);
    await expect(runNote({ ...pc1, text: WHY, files: ['../etc/passwd'] })).rejects.toThrow(
      CrewmindError,
    );
    expect(outbox(pc1)).toHaveLength(0);
  });

  it('refuses to run before init', async () => {
    const remote = await makeRemote();
    const cwd = join(dir, 'raw');
    await runGit(['clone', '-q', remote, cwd]);
    await expect(runNote({ cwd, dataDir: join(dir, 'd'), text: WHY })).rejects.toThrow(
      /crewmind init/,
    );
  });
});

describe('crewmind sync', () => {
  it('round trip: a note from PC 1 reaches PC 2', async () => {
    const remote = await makeRemote();
    const pc1 = await machine('pc1', remote);
    const pc2 = await machine('pc2', remote);
    const { record } = await runNote({ ...pc1, text: WHY, type: 'decision' });

    expect(await runSync({ ...pc1, now: true })).toMatchObject({ sent: 1, received: 0 });
    expect(outbox(pc1)).toHaveLength(0);
    expect(records(pc1).map((r) => r.id)).toEqual([record.id]);

    expect(await runSync(pc2)).toMatchObject({ sent: 0, received: 1 });
    expect(records(pc2)).toEqual([record]);
    // Hidden ref only: no branch or tag on the remote changed.
    const heads = await runGit(['--git-dir', remote, 'for-each-ref', '--format=%(refname)']);
    expect(heads.trim().split('\n').sort()).toEqual([MEMORY_REF, 'refs/heads/main']);
  });

  it('is quiet when nothing changed', async () => {
    const pc1 = await machine('pc1', await makeRemote());
    expect(await runSync(pc1)).toMatchObject({ sent: 0, received: 0 });
  });

  it('loses nothing when two machines sync at the same time', async () => {
    const remote = await makeRemote();
    const pc1 = await machine('pc1', remote);
    const pc2 = await machine('pc2', remote);
    const a = await runNote({ ...pc1, text: WHY });
    const b = await runNote({ ...pc2, text: `${WHY} (second)` });
    await Promise.all([runSync({ ...pc1, now: true }), runSync({ ...pc2, now: true })]);
    await runSync(pc1);
    await runSync(pc2);
    const want = [a.record.id, b.record.id].sort();
    expect(
      records(pc1)
        .map((r) => r.id)
        .sort(),
    ).toEqual(want);
    expect(
      records(pc2)
        .map((r) => r.id)
        .sort(),
    ).toEqual(want);
  });

  it('offline: keeps notes queued, then sends them once the remote is back', async () => {
    const remote = await makeRemote();
    const pc1 = await machine('pc1', remote);
    await runNote({ ...pc1, text: WHY });
    await rename(remote, `${remote}.offline`);

    const err = await runSync({ ...pc1, now: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrewmindError);
    expect((err as Error).message).toMatch(/1 note.*queued/);
    expect(outbox(pc1)).toHaveLength(1);

    await rename(`${remote}.offline`, remote);
    expect(await runSync({ ...pc1, now: true })).toMatchObject({ sent: 1 });
    expect(outbox(pc1)).toHaveLength(0);
  });
});
