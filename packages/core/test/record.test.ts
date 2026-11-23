import { describe, expect, it } from 'vitest';
import { newId } from '../src/ids.js';
import { ConflictRecord, ContextRecord, RepoPath, Tombstone } from '../src/schema/record.js';

const author = 'm_aliyan01';
const now = '2026-11-23T10:00:00.000Z';

function validRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: newId(),
    type: 'decision',
    title: 'Auth moved to httpOnly session cookies',
    body: 'Why: tokens in localStorage were exposed to XSS. All routes now use requireSession.',
    tags: ['auth', 'security'],
    files: ['src/server/auth/', 'src/middleware.ts'],
    scope: 'branch',
    branch: 'feat/session-cookies',
    commit: 'a1b2c3d',
    source: 'agent',
    tool: 'claude-code',
    author,
    createdAt: now,
    scanner: '0.1.0',
    ...overrides,
  };
}

describe('ContextRecord', () => {
  it('accepts a valid record', () => {
    expect(ContextRecord.safeParse(validRecord()).success).toBe(true);
  });

  it('defaults tags and files to empty arrays', () => {
    const { tags: _t, files: _f, ...rest } = validRecord({ scope: 'project', branch: undefined });
    const parsed = ContextRecord.parse(rest);
    expect(parsed.tags).toEqual([]);
    expect(parsed.files).toEqual([]);
  });

  it.each([
    ['body too short', { body: 'too short' }],
    ['body too long', { body: 'x'.repeat(4001) }],
    ['unknown type', { type: 'rumor' }],
    ['branch scope without branch', { branch: undefined }],
    ['bad commit sha', { commit: 'not-hex!' }],
    ['bad author id', { author: 'aliyan' }],
    ['uppercase tag', { tags: ['Auth'] }],
    ['too many tags', { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }],
    [
      'self-supersede',
      { id: '01J0000000000000000000000A', supersedes: '01J0000000000000000000000A' },
    ],
    ['unknown field', { secretPayload: 'x' }],
    ['non-ISO date', { createdAt: 'yesterday' }],
  ])('rejects %s', (_label, overrides) => {
    expect(ContextRecord.safeParse(validRecord(overrides)).success).toBe(false);
  });
});

describe('RepoPath', () => {
  it.each(['src/auth/', 'README.md', 'a/b/c.ts'])('accepts %s', (p) => {
    expect(RepoPath.safeParse(p).success).toBe(true);
  });

  it.each(['/etc/passwd', 'C:/x', '..', 'src/../../secret', 'src\\win', ''])('rejects %s', (p) => {
    expect(RepoPath.safeParse(p).success).toBe(false);
  });
});

describe('Tombstone', () => {
  it('accepts a retraction', () => {
    expect(
      Tombstone.safeParse({ id: newId(), retracts: newId(), author, createdAt: now }).success,
    ).toBe(true);
  });
});

describe('ConflictRecord', () => {
  const base = {
    id: newId(),
    type: 'conflict',
    a: newId(),
    b: newId(),
    summary: 'Offset vs cursor pagination for /api/items',
    author,
    createdAt: now,
  };

  it('accepts an open conflict', () => {
    expect(ConflictRecord.safeParse({ ...base, status: 'open' }).success).toBe(true);
  });

  it('accepts a resolved conflict with a resolution', () => {
    const resolved = { ...base, status: 'resolved', resolution: { by: author, outcome: 'b' } };
    expect(ConflictRecord.safeParse(resolved).success).toBe(true);
  });

  it('rejects resolved without resolution, and open with resolution', () => {
    expect(ConflictRecord.safeParse({ ...base, status: 'resolved' }).success).toBe(false);
    const openWithResolution = {
      ...base,
      status: 'open',
      resolution: { by: author, outcome: 'a' },
    };
    expect(ConflictRecord.safeParse(openWithResolution).success).toBe(false);
  });

  it('rejects a conflict between a record and itself', () => {
    expect(ConflictRecord.safeParse({ ...base, b: base.a, status: 'open' }).success).toBe(false);
  });
});
