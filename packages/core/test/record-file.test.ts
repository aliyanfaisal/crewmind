import { describe, expect, it } from 'vitest';
import { newId } from '../src/ids.js';
import type { ContextRecord } from '../src/schema/record.js';
import { parseRecordFile, recordIdFromPath, recordPath } from '../src/schema/record-file.js';

const record: ContextRecord = {
  id: newId(),
  type: 'decision',
  title: 'Use advisory locks',
  body: 'Advisory locks over SKIP LOCKED because the queue table is tiny and contention is low.',
  tags: [],
  files: [],
  scope: 'project',
  source: 'cli',
  author: 'm_abc123',
  createdAt: '2026-11-25T10:00:00.000Z',
  scanner: 'v1',
};

describe('record file paths', () => {
  it('round-trips an id through its path', () => {
    expect(recordPath(record.id)).toBe(`records/${record.id}.json`);
    expect(recordIdFromPath(recordPath(record.id))).toBe(record.id);
  });

  it('ignores anything that is not exactly records/<ulid>.json', () => {
    for (const p of [
      'crewmind.json',
      `records/${record.id}.age`,
      `records/sub/${record.id}.json`,
      `tombstones/${record.id}.json`,
      'records/not-a-ulid.json',
      `xrecords/${record.id}.json`,
    ]) {
      expect(recordIdFromPath(p)).toBeNull();
    }
  });
});

describe('parseRecordFile', () => {
  const path = recordPath(record.id);
  const file = (body: unknown) => JSON.stringify(body);

  it('accepts a valid v1 file', () => {
    expect(parseRecordFile(path, file({ v: 1, record }))).toEqual(record);
  });

  it('rejects malformed JSON, unknown versions and unknown fields', () => {
    expect(() => parseRecordFile(path, '{not json')).toThrow();
    expect(() => parseRecordFile(path, file({ v: 2, record }))).toThrow();
    expect(() => parseRecordFile(path, file({ v: 1, record, extra: true }))).toThrow();
    expect(() => parseRecordFile(path, file({ v: 1, record: { ...record, x: 1 } }))).toThrow();
  });

  it('rejects a record whose id does not match its file name', () => {
    // Otherwise a pushed file could silently overwrite another record in the index.
    expect(() => parseRecordFile(recordPath(newId()), file({ v: 1, record }))).toThrow(/match/);
  });

  it('rejects oversized files before parsing', () => {
    expect(() => parseRecordFile(path, ' '.repeat(70_000))).toThrow(/large/);
  });
});
