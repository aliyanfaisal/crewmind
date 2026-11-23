import { z } from 'zod';
import { ID_PATTERN, newId } from '../ids.js';
import { Timestamp } from './record.js';

export const PROJECT_ID_PATTERN = new RegExp(`^p_${ID_PATTERN.source.slice(1, -1)}$`);
export const ProjectId = z.string().regex(PROJECT_ID_PATTERN, 'must look like p_<ULID>');

export function newProjectId(now: number = Date.now()): string {
  return `p_${newId(now)}`;
}

/** Current on-ref format. Readers refuse newer formats instead of misreading them. */
export const MANIFEST_FORMAT = 1;

/** `crewmind.json` at the root of refs/crewmind/memory. Plaintext by design (PLAN §4.2). */
export const ProjectManifest = z
  .object({
    format: z.literal(MANIFEST_FORMAT),
    projectId: ProjectId,
    // false only for pre-M6 plaintext test memories.
    encryption: z.boolean(),
    createdAt: Timestamp,
  })
  .strict();
export type ProjectManifest = z.infer<typeof ProjectManifest>;

/** `.crewmind/config.json` in the working repo (kept out of git via .git/info/exclude). */
export const RepoConfig = z
  .object({
    projectId: ProjectId,
    remote: z
      .string()
      .min(1)
      .max(100)
      // Must not start with "-", so a remote name can never be read as a git option.
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'must be a git remote name'),
  })
  .strict();
export type RepoConfig = z.infer<typeof RepoConfig>;
