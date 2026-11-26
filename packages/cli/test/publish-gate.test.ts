import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../src/commands/init.js';
import { runNote } from '../src/commands/note.js';
import { runStatus } from '../src/commands/status.js';
import { runSync } from '../src/commands/sync.js';
import { runGit } from '../src/git/exec.js';
import { MEMORY_REF } from '../src/git/memory.js';

// Publish gate (D29): a note leaves only once the remote branch has a commit made after it.

vi.setConfig({ testTimeout: 60_000 });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crewmind gate '));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const WHY = 'Retry webhooks with jittered backoff because the provider rate-limits bursts.';
const ident = ['-c', 'user.name=dev', '-c', 'user.email=dev@invalid'];

async function setup() {
  const remote = join(dir, 'remote.git');
  const seed = join(dir, 'seed');
  await runGit(['init', '-q', '--bare', '-b', 'main', remote]);
  await runGit(['init', '-q', '-b', 'main', seed]);
  await writeFile(join(seed, 'README.md'), 'hi\n');
  await runGit(['add', '.'], { cwd: seed });
  await runGit([...ident, 'commit', '-qm', 'init'], { cwd: seed });
  await runGit(['push', '-q', remote, 'main'], { cwd: seed });
  const cwd = join(dir, 'pc1', 'project');
  await runGit(['clone', '-q', remote, cwd]);
  const pc = { cwd, dataDir: join(dir, 'pc1', '.crewmind') };
  await runInit(pc);
  return { remote, pc };
}

/** Commits a change in the working repo. `future` dates it ahead so time-based checks are exact. */
async function commitCode(cwd: string, name: string, opts: { amend?: boolean } = {}) {
  await writeFile(join(cwd, name), `${name}\n`);
  await runGit(['add', '.'], { cwd });
  const date = new Date(Date.now() + 60_000).toISOString();
  await runGit([...ident, 'commit', '-q', ...(opts.amend ? ['--amend'] : []), '-m', name], {
    cwd,
    env: { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
  });
}

const push = (cwd: string, ...args: string[]) =>
  runGit(['push', '-q', ...args, 'origin', 'HEAD'], { cwd });

async function remoteRecordCount(remote: string): Promise<number> {
  try {
    const out = await runGit([
      '--git-dir',
      remote,
      'ls-tree',
      '--name-only',
      `${MEMORY_REF}:records`,
    ]);
    return out.trim().split('\n').filter(Boolean).length;
  } catch {
    return 0; // no records/ dir yet
  }
}

describe('publish gate', () => {
  it('holds a note about unpushed work, then releases it after the push', async () => {
    const { remote, pc } = await setup();
    await runNote({ ...pc, text: WHY });

    expect(await runSync(pc)).toMatchObject({ sent: 0, held: 1 });
    expect(await remoteRecordCount(remote)).toBe(0);
    const status = await runStatus(pc);
    expect(status.held).toHaveLength(1);
    expect(status.held[0]).toMatchObject({ branch: 'main' });

    await commitCode(pc.cwd, 'webhooks.ts');
    expect(await runSync(pc)).toMatchObject({ sent: 0, held: 1 }); // committed, not pushed
    await push(pc.cwd);
    expect(await runSync(pc)).toMatchObject({ sent: 1, held: 0 });
    expect(await remoteRecordCount(remote)).toBe(1);
    expect((await runStatus(pc)).held).toHaveLength(0);
  });

  it('keeps holding when the remote branch has nothing newer than the note', async () => {
    const { pc } = await setup();
    await runNote({ ...pc, text: WHY }); // HEAD is already on the remote
    expect(await runSync(pc)).toMatchObject({ sent: 0, held: 1 });
  });

  it('holds notes on a branch that was never pushed', async () => {
    const { pc } = await setup();
    await runGit(['switch', '-q', '-c', 'feat/hooks'], { cwd: pc.cwd });
    await runNote({ ...pc, text: WHY });
    await commitCode(pc.cwd, 'a.ts');
    expect(await runSync(pc)).toMatchObject({ sent: 0, held: 1 });
    await push(pc.cwd, '-u');
    expect(await runSync(pc)).toMatchObject({ sent: 1, held: 0 });
  });

  it('releases after a rewritten push (amend + force) that is newer than the note', async () => {
    const { pc } = await setup();
    await commitCode(pc.cwd, 'a.ts');
    await runNote({ ...pc, text: WHY }); // anchored to the commit we're about to amend away
    await commitCode(pc.cwd, 'b.ts', { amend: true });
    await push(pc.cwd, '--force');
    expect(await runSync(pc)).toMatchObject({ sent: 1, held: 0 });
  });

  it('only releases notes whose branch was pushed', async () => {
    const { pc } = await setup();
    await runNote({ ...pc, text: WHY });
    await runGit(['switch', '-q', '-c', 'feat/other'], { cwd: pc.cwd });
    await runNote({ ...pc, text: `${WHY} (other branch)` });
    await commitCode(pc.cwd, 'x.ts');
    await push(pc.cwd, '-u');
    // feat/other has a newer commit; main does not.
    expect(await runSync(pc)).toMatchObject({ sent: 1, held: 1 });
    expect((await runStatus(pc)).held[0]).toMatchObject({ branch: 'main' });
  });

  it('note --now and sync --now skip the gate', async () => {
    const { remote, pc } = await setup();
    await runNote({ ...pc, text: WHY, now: true });
    expect(await remoteRecordCount(remote)).toBe(1);

    await runNote({ ...pc, text: `${WHY} (later)` });
    expect(await runSync(pc)).toMatchObject({ sent: 0, held: 1 });
    expect(await runSync({ ...pc, now: true })).toMatchObject({ sent: 1, held: 0 });
    expect(await remoteRecordCount(remote)).toBe(2);
  });

  it('never touches the working repo (refs and tree unchanged)', async () => {
    const { pc } = await setup();
    await runNote({ ...pc, text: WHY });
    const refs = await runGit(['for-each-ref'], { cwd: pc.cwd });
    await runSync(pc);
    await runStatus(pc);
    expect(await runGit(['for-each-ref'], { cwd: pc.cwd })).toBe(refs);
    expect(await runGit(['status', '--porcelain'], { cwd: pc.cwd })).toBe('');
  });

  it('status still lists held notes when the remote is unreachable', async () => {
    const { remote, pc } = await setup();
    await runNote({ ...pc, text: WHY });
    await rm(remote, { recursive: true, force: true });
    const status = await runStatus(pc);
    expect(status.held).toHaveLength(1);
    expect(status.offline).toBe(true);
  });
});
