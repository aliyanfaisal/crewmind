import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { RepoConfig } from '@crewmind/core';
import { CrewmindError } from './errors.js';
import { runGit } from './git/exec.js';

// Local, per-machine state. The only things Crewmind writes inside the working repo are
// `.crewmind/` and one line in `.git/info/exclude` (D12). Never `.gitignore`, never branches.

export const CONFIG_DIR = '.crewmind';

export function cachePath(dataDir: string, projectId: string): string {
  return join(dataDir, 'repos', `${projectId}.git`);
}

function configFile(repoRoot: string): string {
  return join(repoRoot, CONFIG_DIR, 'config.json');
}

/** The repo's Crewmind config, or null when the repo isn't set up yet. */
export async function readRepoConfig(repoRoot: string): Promise<RepoConfig | null> {
  let raw: string;
  try {
    raw = await readFile(configFile(repoRoot), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const result = RepoConfig.safeParse(parsed);
  if (!result.success) {
    throw new CrewmindError(
      `${CONFIG_DIR}/config.json is invalid. Delete the ${CONFIG_DIR} folder and run crewmind init again.`,
    );
  }
  return result.data;
}

export async function writeRepoConfig(repoRoot: string, config: RepoConfig): Promise<void> {
  const file = configFile(repoRoot);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(RepoConfig.parse(config), null, 2)}\n`);
}

/** Adds `pattern` to .git/info/exclude once (works for worktrees too). */
export async function addToExclude(repoRoot: string, pattern: string): Promise<void> {
  const rel = (await runGit(['rev-parse', '--git-path', 'info/exclude'], { cwd: repoRoot })).trim();
  const file = resolve(repoRoot, rel);
  let current = '';
  try {
    current = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (current.split(/\r?\n/).includes(pattern)) return;
  await mkdir(dirname(file), { recursive: true });
  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  await writeFile(file, `${current}${sep}# Crewmind local state\n${pattern}\n`);
}
