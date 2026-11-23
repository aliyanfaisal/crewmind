import { describe, expect, it } from 'vitest';
import { newProjectId, ProjectId, ProjectManifest, RepoConfig } from '../src/index.js';

const manifest = {
  format: 1,
  projectId: newProjectId(),
  encryption: false,
  createdAt: '2026-11-24T10:00:00.000Z',
};

describe('project schemas', () => {
  it('generates valid project ids', () => {
    expect(ProjectId.safeParse(newProjectId()).success).toBe(true);
    expect(ProjectId.safeParse('p_123').success).toBe(false);
    expect(ProjectId.safeParse('../../etc').success).toBe(false);
  });

  it('accepts a valid manifest and rejects unknown or newer formats', () => {
    expect(ProjectManifest.safeParse(manifest).success).toBe(true);
    expect(ProjectManifest.safeParse({ ...manifest, format: 2 }).success).toBe(false);
    expect(ProjectManifest.safeParse({ ...manifest, extra: true }).success).toBe(false);
  });

  it('accepts remote names but not arbitrary strings', () => {
    const base = { projectId: manifest.projectId };
    expect(RepoConfig.safeParse({ ...base, remote: 'origin' }).success).toBe(true);
    expect(RepoConfig.safeParse({ ...base, remote: '--upload-pack' }).success).toBe(false);
    expect(RepoConfig.safeParse({ ...base, remote: 'a b' }).success).toBe(false);
  });
});
