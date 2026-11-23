import { homedir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { runInit } from './commands/init.js';
import { findRepoRoot } from './git/repo.js';
import { readRepoConfig } from './project.js';

export interface ProgramIO {
  out: (text: string) => void;
  err: (text: string) => void;
  cwd: string;
  /** Crewmind's per-user data folder, normally ~/.crewmind. */
  dataDir: string;
}

function defaultIO(): ProgramIO {
  return {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    cwd: process.cwd(),
    // CREWMIND_HOME lets one computer act as two machines when testing.
    dataDir: process.env.CREWMIND_HOME ?? join(homedir(), '.crewmind'),
  };
}

const PLAINTEXT_WARNING =
  '\n⚠ Pre-release: notes are NOT encrypted yet (encryption arrives before the first release).\n' +
  '  Only use Crewmind on a private, throwaway test repository for now.\n';

/** Builds the CLI. Kept separate from the entry point so tests can run commands in-process. */
export function createProgram(io: ProgramIO = defaultIO()): Command {
  const program = new Command()
    .name('crewmind')
    .description(pkg.description)
    .version(pkg.version, '-v, --version')
    .configureOutput({ writeOut: io.out, writeErr: io.err })
    .showHelpAfterError();

  program
    .command('init')
    .description("Set up Crewmind in this repository (creates or joins the team's memory)")
    .option('--remote <name>', 'git remote that holds the team memory', 'origin')
    .action(async (opts: { remote: string }) => {
      const r = await runInit({ cwd: io.cwd, dataDir: io.dataDir, remote: opts.remote });
      const headline = {
        created: '✓ Created team memory for this repository.',
        joined: "✓ Connected to this repository's existing team memory.",
        already: 'Crewmind is already set up in this repository.',
      }[r.status];
      io.out(
        `${headline}\n  Project: ${r.projectId}\n  Remote:  ${r.remote} (${r.remoteUrl})\n` +
          '  Notes live in refs/crewmind/memory: hidden from branches, clones and CI.\n' +
          PLAINTEXT_WARNING,
      );
    });

  program
    .command('status')
    .description('Show Crewmind status for the current repository')
    .action(async () => {
      const repoRoot = await findRepoRoot(io.cwd);
      if (!repoRoot) {
        io.out('Not inside a git repository.\n');
        return;
      }
      const config = await readRepoConfig(repoRoot);
      if (!config) {
        io.out("Crewmind isn't set up in this repository yet. Run: crewmind init\n");
        return;
      }
      io.out(`Crewmind is set up.\n  Project: ${config.projectId}\n  Remote:  ${config.remote}\n`);
    });

  return program;
}
