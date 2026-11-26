import { ContextRecord, LIMITS, newId, type RecordType } from '@crewmind/core';
import { CrewmindError } from '../errors.js';
import { memberId, openWorkspace, workingHead } from '../workspace.js';

export interface NoteOptions {
  cwd: string;
  dataDir: string;
  text: string;
  type?: RecordType;
  title?: string;
  files?: string[];
  tags?: string[];
  supersedes?: string;
}

const TITLE_DEFAULT_MAX = 80;

/**
 * Creates a record and queues it in the outbox. Until review lands (M3) notes skip drafts;
 * until the publish gate lands they leave on the next `sync`.
 */
export async function runNote(opts: NoteOptions): Promise<{ record: ContextRecord }> {
  const body = opts.text.trim();
  if (body.length < LIMITS.bodyMin) {
    throw new CrewmindError(
      `Notes need at least ${LIMITS.bodyMin} characters, so teammates get the "why", not just the "what".`,
    );
  }
  const ws = await openWorkspace(opts);
  try {
    const { branch, head } = await workingHead(ws.repoRoot);
    const parsed = ContextRecord.safeParse({
      id: newId(),
      type: opts.type ?? 'note',
      title: opts.title?.trim() || defaultTitle(body),
      body,
      tags: opts.tags ?? [],
      // Accept Windows-style input; records always store POSIX paths.
      files: (opts.files ?? []).map((f) => f.replaceAll('\\', '/')),
      scope: 'project',
      ...(head ? { commit: head } : {}),
      ...(opts.supersedes ? { supersedes: opts.supersedes } : {}),
      source: 'cli',
      author: await memberId(opts.dataDir),
      createdAt: new Date().toISOString(),
      // The privacy scanner arrives in M3. Until then, test repos only (PLAN §8).
      scanner: 'none',
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new CrewmindError(
        `Invalid note: ${issue?.path.join('.') || 'note'}: ${issue?.message ?? 'invalid'}`,
      );
    }
    ws.store.enqueue(parsed.data, { branch, head });
    return { record: parsed.data };
  } finally {
    ws.store.close();
  }
}

/** First line, cut at a word boundary. */
function defaultTitle(body: string): string {
  const line = (body.split('\n')[0] ?? body).trim();
  if (line.length <= TITLE_DEFAULT_MAX) return line;
  const cut = line.slice(0, TITLE_DEFAULT_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
