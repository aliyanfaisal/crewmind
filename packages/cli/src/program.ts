import { Command } from 'commander';
import pkg from '../package.json' with { type: 'json' };

export interface ProgramIO {
  out: (text: string) => void;
  err: (text: string) => void;
}

const defaultIO: ProgramIO = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/** Builds the CLI. Kept separate from the entry point so tests can run commands in-process. */
export function createProgram(io: ProgramIO = defaultIO): Command {
  const program = new Command()
    .name('crewmind')
    .description(pkg.description)
    .version(pkg.version, '-v, --version')
    .configureOutput({ writeOut: io.out, writeErr: io.err })
    .showHelpAfterError();

  program
    .command('status')
    .description('Show Crewmind status for the current repository')
    .action(() => {
      // Stub until M2 (git storage + sync).
      io.out(
        'Crewmind is not initialized in this repository yet. (`crewmind init` arrives in M2.)\n',
      );
    });

  return program;
}
