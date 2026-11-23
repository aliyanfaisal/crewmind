import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { createProgram } from '../src/program.js';

async function run(...args: string[]) {
  let out = '';
  let err = '';
  const program = createProgram({ out: (t) => (out += t), err: (t) => (err += t) }).exitOverride();
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
    const { out, exitCode } = await run('--version');
    expect(exitCode).toBe(0);
    expect(out.trim()).toBe(pkg.version);
  });

  it('lists commands in help', async () => {
    const { out } = await run('--help');
    expect(out).toContain('status');
  });

  it('status explains that the repo is not initialized yet', async () => {
    const { out, exitCode } = await run('status');
    expect(exitCode).toBe(0);
    expect(out).toContain('not initialized');
  });

  it('rejects unknown commands with a non-zero exit', async () => {
    const { err, exitCode } = await run('nope');
    expect(exitCode).not.toBe(0);
    expect(err).toContain('unknown command');
  });
});
