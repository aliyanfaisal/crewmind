import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { runGit } from '../src/git/exec.js';
import { createProgram } from '../src/program.js';

vi.setConfig({ testTimeout: 60_000 });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crewmind cli '));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function run(cwd: string, ...args: string[]) {
  let out = '';
  let err = '';
  const program = createProgram({
    out: (t) => (out += t),
    err: (t) => (err += t),
    cwd,
    dataDir: join(dir, '.crewmind'),
  }).exitOverride();
  let exitCode = 0;
  try {
    await program.parseAsync(['node', 'crewmind', ...args]);
  } catch (error) {
    exitCode = (error as { exitCode?: number }).exitCode ?? 1;
  }
  return { out, err, exitCode };
}

describe('crewmind CLI', () => {
  it('prints the package version', async () => {
    const { out, exitCode } = await run(dir, '--version');
    expect(exitCode).toBe(0);
    expect(out.trim()).toBe(pkg.version);
  });

  it('lists commands in help', async () => {
    const { out } = await run(dir, '--help');
    expect(out).toContain('init');
    expect(out).toContain('status');
  });

  it('status outside a repo says so', async () => {
    const { out, exitCode } = await run(dir, 'status');
    expect(exitCode).toBe(0);
    expect(out).toContain('Not inside a git repository');
  });

  it('init then status shows the project, with the plaintext warning', async () => {
    const remote = join(dir, 'remote.git');
    const work = join(dir, 'work');
    await runGit(['init', '-q', '--bare', remote]);
    await runGit(['init', '-q', work]);
    await runGit(['remote', 'add', 'origin', remote], { cwd: work });

    expect((await run(work, 'status')).out).toContain('crewmind init');
    const init = await run(work, 'init');
    expect(init.out).toContain('Created team memory');
    expect(init.out).toContain('NOT encrypted');
    const status = await run(work, 'status');
    expect(status.out).toMatch(/Project: p_[0-9A-Z]{26}/);
  });

  it('rejects unknown commands with a non-zero exit', async () => {
    const { err, exitCode } = await run(dir, 'nope');
    expect(exitCode).not.toBe(0);
    expect(err).toContain('unknown command');
  });
});
