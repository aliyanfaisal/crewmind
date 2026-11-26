import { CrewmindError } from '../errors.js';
import { reach } from '../git/reach.js';
import type { OutboxEntry } from '../store/db.js';
import { applyGate } from '../sync/gate.js';
import { openWorkspace } from '../workspace.js';

export interface QueuedNote {
  id: string;
  title: string;
  branch: string | null;
  queuedAt: string;
}

export interface StatusResult {
  projectId: string;
  remote: string;
  records: number;
  /** Waiting for a push of their branch (D29). */
  held: QueuedNote[];
  /** Released by the gate; the next sync sends them. */
  ready: QueuedNote[];
  /** The remote couldn't be checked, so every queued note is listed as held. */
  offline: boolean;
}

/** Reports what's indexed and what's queued. Nothing waits silently (D29). */
export async function runStatus(opts: { cwd: string; dataDir: string }): Promise<StatusResult> {
  const ws = await openWorkspace(opts);
  try {
    const queued = ws.store.outbox();
    let gate = { ready: [] as OutboxEntry[], held: queued };
    let offline = false;
    try {
      gate = await reach(
        () => applyGate(ws.cache, ws.repoRoot, queued),
        ws.config.remote,
        ws.remoteUrl,
      );
    } catch (e) {
      if (!(e instanceof CrewmindError)) throw e;
      offline = true;
    }
    return {
      projectId: ws.config.projectId,
      remote: ws.config.remote,
      records: ws.store.listRecords().length,
      held: gate.held.map(summary),
      ready: gate.ready.map(summary),
      offline,
    };
  } finally {
    ws.store.close();
  }
}

function summary(e: OutboxEntry): QueuedNote {
  return { id: e.record.id, title: e.record.title, branch: e.branch, queuedAt: e.queuedAt };
}
