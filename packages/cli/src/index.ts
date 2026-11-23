import { createProgram } from './program.js';

createProgram()
  .parseAsync(process.argv)
  .catch((error: unknown) => {
    const debug = process.argv.includes('--debug');
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`crewmind: ${message}\n`);
    if (debug && error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  });
