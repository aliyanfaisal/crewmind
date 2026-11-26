import { CrewmindError } from '../errors.js';
import { GitError } from './exec.js';
import { isPushRejected } from './memory.js';

/** Turns network and auth failures into a message the user can act on. */
export async function reach<T>(
  fn: () => Promise<T>,
  remote: string,
  remoteUrl: string,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    if (isPushRejected(e)) throw new CrewmindError('Push rejected.', { cause: e });
    const detail = e.stderr.trim().split('\n')[0] ?? '';
    throw new CrewmindError(
      `Could not reach "${remote}" (${remoteUrl}). Check that \`git fetch ${remote}\` works. ${detail}`.trim(),
      { cause: e },
    );
  }
}
