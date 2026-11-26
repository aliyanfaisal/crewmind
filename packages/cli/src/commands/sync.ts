import { canonicalize, RECORD_FILE_VERSION, recordPath } from '@crewmind/core';
import { CrewmindError } from '../errors.js';
import { fetchMemory, publish } from '../git/memory.js';
import { reach } from '../git/reach.js';
import { type DroppedFile, indexMemory } from '../store/index-memory.js';
import { applyGate } from '../sync/gate.js';
import { openWorkspace } from '../workspace.js';

export interface SyncOptions {
  cwd: string;
  dataDir: string;
  /** Send every queued record, skipping the publish gate. */
  now?: boolean;
  /** Send these queued records even if the gate would hold them (`note --now`). */
  sendIds?: readonly string[];
}

export interface SyncResult {
  sent: number;
  /** Still waiting for the code push (D29). */
  held: number;
  received: number;
  dropped: DroppedFile[];
}

/** Sends what the publish gate releases, then indexes everything new on the remote. */
export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const ws = await openWorkspace(opts);
  const { store } = ws;
  try {
    const queued = store.outbox();
    const net = <T>(fn: () => Promise<T>) =>
      reach(fn, ws.config.remote, ws.remoteUrl).catch((e: unknown) => {
        if (queued.length === 0 || !(e instanceof CrewmindError)) throw e;
        const n = `${queued.length} note${queued.length === 1 ? '' : 's'}`;
        throw new CrewmindError(
          `${e.message}\n${n} stay queued and will be sent on the next sync.`,
          {
            cause: e,
          },
        );
      });

    const forced = new Set(opts.sendIds);
    const gated = queued.filter((q) => !opts.now && !forced.has(q.record.id));
    const { ready, held } = await net(() => applyGate(ws.cache, ws.repoRoot, gated));
    const toSend = [...queued.filter((q) => !gated.includes(q)), ...ready];

    let head: string | null;
    if (toSend.length > 0) {
      const files = toSend.map((q) => ({
        path: recordPath(q.record.id),
        content: `${canonicalize({ v: RECORD_FILE_VERSION, record: q.record })}\n`,
      }));
      head = await net(() => publish(ws.cache, files));
      // If we crash before this, the next sync re-pushes identical files: a no-op change.
      store.dequeue(toSend.map((q) => q.record.id));
    } else {
      head = await net(() => fetchMemory(ws.cache));
    }

    const ownIds = new Set(toSend.map((q) => q.record.id));
    const before = new Set(store.listRecords().map((r) => r.id));
    const indexed = await indexMemory(ws.cache, store, head);
    const received = store
      .listRecords()
      .filter((r) => !before.has(r.id) && !ownIds.has(r.id)).length;
    return { sent: toSend.length, held: held.length, received, dropped: indexed.dropped };
  } finally {
    store.close();
  }
}
