import { z } from 'zod';
import { ID_PATTERN } from '../ids.js';

/** Limits from PLAN §5.1. Records are injected into other people's AI sessions, so they stay small. */
export const LIMITS = {
  titleMax: 200,
  bodyMin: 40,
  bodyMax: 4000,
  tagsMax: 10,
  tagMax: 40,
  filesMax: 30,
  pathMax: 300,
  summaryMax: 1000,
} as const;

export const RecordId = z.string().regex(ID_PATTERN, 'must be a ULID');
export const MemberId = z.string().regex(/^m_[a-z0-9]{6,32}$/, 'must look like m_xxxxxx');
export const CommitSha = z.string().regex(/^[0-9a-f]{7,64}$/, 'must be a hex commit sha');
export const Timestamp = z.iso.datetime({ offset: true });

/**
 * Repo-relative path or directory, POSIX separators. Rejects absolute paths, `..` segments
 * and backslashes, so a record can never point outside the repo.
 */
export const RepoPath = z
  .string()
  .min(1)
  .max(LIMITS.pathMax)
  .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p), 'must be repo-relative')
  .refine((p) => !p.includes('\\'), 'must use forward slashes')
  .refine((p) => !p.split('/').includes('..'), 'must not contain ".."');

export const RecordType = z.enum(['decision', 'constraint', 'issue', 'change', 'handoff', 'note']);
export type RecordType = z.infer<typeof RecordType>;

export const RecordSource = z.enum(['agent', 'cli', 'hook']);

const Tag = z
  .string()
  .min(1)
  .max(LIMITS.tagMax)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'tags are lowercase: a-z 0-9 . _ -');

export const ContextRecord = z
  .object({
    id: RecordId,
    type: RecordType,
    title: z.string().trim().min(1).max(LIMITS.titleMax),
    body: z.string().trim().min(LIMITS.bodyMin).max(LIMITS.bodyMax),
    tags: z.array(Tag).max(LIMITS.tagsMax).default([]),
    files: z.array(RepoPath).max(LIMITS.filesMax).default([]),
    scope: z.enum(['project', 'branch']),
    branch: z.string().min(1).max(255).optional(),
    commit: CommitSha.optional(),
    supersedes: RecordId.optional(),
    source: RecordSource,
    tool: z.string().min(1).max(40).optional(),
    author: MemberId,
    createdAt: Timestamp,
    scanner: z.string().min(1).max(40),
  })
  .strict()
  .refine((r) => r.scope !== 'branch' || r.branch !== undefined, {
    message: 'branch-scoped records need a branch',
    path: ['branch'],
  })
  .refine((r) => r.supersedes !== r.id, {
    message: 'a record cannot supersede itself',
    path: ['supersedes'],
  });
export type ContextRecord = z.infer<typeof ContextRecord>;

/** Retraction of a record (PLAN §5.1). Only the author or the founding member may retract. */
export const Tombstone = z
  .object({
    id: RecordId,
    retracts: RecordId,
    author: MemberId,
    createdAt: Timestamp,
    reason: z.string().trim().max(LIMITS.summaryMax).optional(),
  })
  .strict();
export type Tombstone = z.infer<typeof Tombstone>;

/** Decision Conflict Radar: a flagged disagreement between two records (PLAN §4.11). */
export const ConflictRecord = z
  .object({
    id: RecordId,
    type: z.literal('conflict'),
    a: RecordId,
    b: RecordId,
    summary: z.string().trim().min(1).max(LIMITS.summaryMax),
    status: z.enum(['open', 'resolved']),
    resolution: z
      .object({
        by: MemberId,
        outcome: z.enum(['a', 'b', 'merged']),
        recordId: RecordId.optional(),
      })
      .strict()
      .optional(),
    author: MemberId,
    createdAt: Timestamp,
  })
  .strict()
  .refine((c) => c.a !== c.b, { message: 'a conflict needs two different records', path: ['b'] })
  .refine((c) => (c.status === 'resolved') === (c.resolution !== undefined), {
    message: 'resolution is required exactly when status is resolved',
    path: ['resolution'],
  });
export type ConflictRecord = z.infer<typeof ConflictRecord>;
