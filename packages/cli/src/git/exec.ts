import { execFile } from 'node:child_process';

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly stdout: string,
  ) {
    super(`git ${args[0] ?? ''} failed (exit ${exitCode ?? 'signal'}): ${stderr.trim()}`);
    this.name = 'GitError';
  }
}

export interface RunGitOptions {
  cwd?: string;
  input?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

// Variables that would redirect git away from the repo we name explicitly,
// e.g. when Crewmind runs from inside another tool's git hook.
const INHERITED_GIT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
];

function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of INHERITED_GIT_VARS) delete env[key];
  // Never block on a credential prompt: hooks run without a terminal.
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  return { ...env, ...extra };
}

/** Runs git with execFile (never a shell). Resolves with stdout. */
export function runGit(args: readonly string[], opts: RunGitOptions = {}): Promise<string> {
  return spawnGit(args, opts, 'utf8');
}

/** Like runGit, but stdout stays raw bytes (for output framed by byte counts). */
export function runGitBuffer(args: readonly string[], opts: RunGitOptions = {}): Promise<Buffer> {
  return spawnGit(args, opts, 'buffer');
}

function spawnGit(args: readonly string[], opts: RunGitOptions, encoding: 'utf8'): Promise<string>;
function spawnGit(
  args: readonly string[],
  opts: RunGitOptions,
  encoding: 'buffer',
): Promise<Buffer>;
function spawnGit(
  args: readonly string[],
  opts: RunGitOptions,
  encoding: 'utf8' | 'buffer',
): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd: opts.cwd,
        env: gitEnv(opts.env),
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        encoding,
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof error.code === 'number' ? error.code : null;
          reject(new GitError(args, code, stderr.toString(), stdout.toString()));
        } else {
          resolve(stdout);
        }
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}
