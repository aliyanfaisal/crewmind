import { z } from 'zod';
import { ID_PATTERN } from '../ids.js';
import { ContextRecord } from './record.js';

// On-ref record files. Pre-M6 they are plaintext `records/<ulid>.json` holding the envelope
// without `epoch` and `sig` (PLAN §4.4). M6 replaces them with encrypted `records/<ulid>.age`.

export const RECORD_FILE_VERSION = 1;
/** Far above any valid record (body ≤ 4000 chars); stops huge blobs before JSON.parse. */
export const RECORD_FILE_MAX_BYTES = 64 * 1024;

const PATH_PATTERN = new RegExp(`^records/(${ID_PATTERN.source.slice(1, -1)})\\.json$`);

export const RecordFile = z
  .object({ v: z.literal(RECORD_FILE_VERSION), record: ContextRecord })
  .strict();
export type RecordFile = z.infer<typeof RecordFile>;

export function recordPath(id: string): string {
  return `records/${id}.json`;
}

/** The record id a path names, or null if the path is not a record file. */
export function recordIdFromPath(path: string): string | null {
  return PATH_PATTERN.exec(path)?.[1] ?? null;
}

/** Thrown for an unusable file. Messages never include file contents. */
export class RecordFileError extends Error {
  override name = 'RecordFileError';
}

/** Parses and validates untrusted file contents read from the ref. */
export function parseRecordFile(path: string, content: string): ContextRecord {
  const id = recordIdFromPath(path);
  if (!id) throw new RecordFileError('not a record path');
  if (new TextEncoder().encode(content).length > RECORD_FILE_MAX_BYTES) {
    throw new RecordFileError('file too large');
  }
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    // V8's message quotes the input, so don't pass it on.
    throw new RecordFileError('invalid JSON');
  }
  const parsed = RecordFile.safeParse(json);
  if (!parsed.success) {
    const where = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`)
      .join(', ');
    throw new RecordFileError(`invalid record file (${where})`);
  }
  if (parsed.data.record.id !== id) {
    throw new RecordFileError('record id does not match file name');
  }
  return parsed.data.record;
}
