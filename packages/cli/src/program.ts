import { homedir } from 'node:os';
import { join } from 'node:path';
import { RecordType } from '@crewmind/core';
import { Command, Option } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { runInit } from './commands/init.js';
import { type NoteOptions, runNote } from './commands/note.js';
import { runSync } from './commands/sync.js';
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
    .command('note')
    .description('Write a note for your team (queued until the next sync)')
    .argument('<text...>', 'what was decided or learned, and why')
    .addOption(
      new Option('-t, --type <type>', 'kind of note').choices(RecordType.options).default('note'),
    )
    .option('--title <title>', 'short title (default: the first line)')
    .option('-f, --files <paths...>', 'files or folders this is about')
    .option('--tags <tags...>', 'lowercase tags')
    .option('--supersedes <id>', 'id of the note this replaces')
    .action(async (text: string[], opts: Omit<NoteOptions, 'cwd' | 'dataDir' | 'text'>) => {
      const { record } = await runNote({
        ...opts,
        cwd: io.cwd,
        dataDir: io.dataDir,
        text: text.join(' '),
      });
      io.out(
        `✓ Queued ${record.type} ${record.id}\n  ${record.title}\n` +
          '  Run `crewmind sync` to send it.\n',
      );
    });

  program
    .command('sync')
    .description('Send queued notes and fetch new ones from your team')
    .action(async () => {
      const r = await runSync({ cwd: io.cwd, dataDir: io.dataDir });
      const plural = (n: number) => `${n} note${n === 1 ? '' : 's'}`;
      io.out(
        r.sent === 0 && r.received === 0
          ? '✓ Up to date.\n'
          : `✓ Sent ${plural(r.sent)}, received ${plural(r.received)}.\n`,
      );
      if (r.dropped.length > 0) {
        io.err(`⚠ Ignored ${plural(r.dropped.length)} that failed validation:\n`);
        for (const d of r.dropped) io.err(`  ${d.path}: ${d.reason}\n`);
      }
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
