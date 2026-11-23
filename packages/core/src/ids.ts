import { monotonicFactory } from 'ulid';

/** Crockford base32 ULID: 26 chars, time-sortable. Used for record, tombstone and conflict ids. */
export const ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const nextUlid = monotonicFactory();

/** New time-sortable id. Monotonic within a process, so ids created in the same millisecond still sort. */
export function newId(now: number = Date.now()): string {
  return nextUlid(now);
}

export function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}
