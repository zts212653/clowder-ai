import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { GlobalArtifactDTO } from '@cat-cafe/shared';
import type { StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import { canViewMessage, isTimelinePublished } from '../../../cats/services/stores/visibility.js';
import type { HomeWorkPublication } from '../host/home/home-hub-delivery.js';
import type { LiveContextScope } from '../host/live-controlled-context.js';
import { readCompanionArtifactLineage } from './companion-work-lineage.js';
import type { CompanionWorkDestination } from './companion-work-navigation.js';
import { companionMessagePublications } from './companion-work-publications.js';
import { type CompanionWorkReadOptions, readCompanionProjectThreads } from './companion-work-read.js';

export type LiveCompanionWorkScope = Pick<LiveContextScope, 'userId' | 'catId' | 'threadId'>;
export interface LiveCompanionWorkReadOptions extends CompanionWorkReadOptions {
  /** Host-owned per-user canonical index, including legacy carriers outside the project list. */
  isCurrentCompanionThread?(userId: string, threadId: string): Promise<boolean>;
}
export interface LiveCompanionWorkCandidate {
  readonly id: string;
  readonly label: string;
  readonly revision: string;
  readonly destination: CompanionWorkDestination;
}

// A Host-bound Live reader is deliberately narrower than the human project overview.
function publications(message: StoredMessage | null, scope: LiveCompanionWorkScope): GlobalArtifactDTO[] {
  if (
    !message ||
    message.deletedAt !== undefined ||
    message.deliveryStatus === 'canceled' ||
    !canViewMessage(message, { type: 'cat', catId: scope.catId }) ||
    !isTimelinePublished(message)
  )
    return [];
  return structuredClone(companionMessagePublications(message, scope.userId, scope.threadId));
}

async function currentRead<T>(options: CompanionWorkReadOptions, read: () => T | Promise<T>): Promise<T> {
  await options.assertCurrent();
  try {
    return await read();
  } finally {
    await options.assertCurrent();
  }
}

async function inScope(options: LiveCompanionWorkReadOptions, scope: LiveCompanionWorkScope) {
  await options.assertCurrent();
  if (scope.userId !== options.ownerUserId) return false;
  if ((await currentRead(options, () => readCompanionProjectThreads(options))).has(scope.threadId)) return true;
  const isCurrent = options.isCurrentCompanionThread;
  return isCurrent ? currentRead(options, () => isCurrent(scope.userId, scope.threadId)) : false;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function label(name: string, revision: number): string {
  const text = [...name]
    .slice(0, 250)
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : char;
    })
    .join('');
  return `${text} · 第${revision}版`;
}

async function stillReadable(options: CompanionWorkReadOptions, scope: LiveCompanionWorkScope, row: GlobalArtifactDTO) {
  const id = row.sourceMessageId;
  if (!id) return false;
  const message = await currentRead(options, () => options.messages.getById(id));
  return publications(message, scope).some((item) => isDeepStrictEqual(item, row));
}

interface Evidence {
  candidate: LiveCompanionWorkCandidate;
  publication: HomeWorkPublication;
}

/** Every metadata byte comes from a currently cat-readable publication, then its original owner. */
async function resolveEvidence(
  options: LiveCompanionWorkReadOptions,
  scope: LiveCompanionWorkScope,
  rows: readonly GlobalArtifactDTO[],
): Promise<Evidence[]> {
  if (!options.artifactLineage || !rows.length) return [];
  const fresh: GlobalArtifactDTO[] = [];
  for (const row of rows) {
    if (await stillReadable(options, scope, row)) fresh.push(row);
  }
  if (!fresh.length) return [];
  const source = await currentRead(options, () =>
    readCompanionArtifactLineage({ ownerUserId: scope.userId, lineage: options.artifactLineage }, fresh, true),
  );
  if (source.workLineage !== 'resolved') return [];
  const result: Evidence[] = [];
  for (const [index, row] of fresh.entries()) {
    const work = source.artifacts[index]?.work;
    if (!work || !row.sourceMessageId || !row.publicationItem || !row.url) continue;
    if (!(await stillReadable(options, scope, row))) continue;
    const destination: CompanionWorkDestination = {
      threadId: row.threadId,
      messageId: row.sourceMessageId,
      item: row.publicationItem,
      sourceRef: `message:${row.threadId}:${row.sourceMessageId}`,
      artifact: { contentRef: work.contentRef, ownerRevision: work.ownerRevision },
    };
    const publication: HomeWorkPublication = {
      source: {
        kind: 'message',
        threadId: row.threadId,
        messageId: row.sourceMessageId,
        messageRevision: String(row.createdAt),
        item: row.publicationItem,
        expectedUrl: row.url,
      },
      artifact: destination.artifact,
    };
    result.push({
      candidate: {
        id: `live-work:${hash([row.threadId, row.sourceMessageId, row.publicationItem])}`,
        label: label(row.name, work.ownerRevision),
        // currentOwnerRevision is not identity: a later v2 must not revoke an unchanged v1.
        revision: hash({ row, artifact: destination.artifact }),
        destination,
      },
      publication,
    });
  }
  if (!(await inScope(options, scope))) return [];
  await options.assertCurrent();
  return result;
}

export async function readLiveCompanionWorkCandidates(
  options: LiveCompanionWorkReadOptions,
  scope: LiveCompanionWorkScope,
): Promise<readonly LiveCompanionWorkCandidate[]> {
  if (!(await inScope(options, scope)) || !options.artifactLineage) return [];
  const messages = await currentRead(options, () =>
    options.messages.getByThread(scope.threadId, 32, scope.userId, { includeQueuedCatMessages: true }),
  );
  const rows = messages
    .slice(-32)
    .flatMap((message) => publications(message, scope))
    .sort((a, b) => b.createdAt - a.createdAt || (a.sourceMessageId ?? '').localeCompare(b.sourceMessageId ?? ''))
    .slice(0, 64);
  return (await resolveEvidence(options, scope, rows)).slice(0, 8).map((row) => row.candidate);
}

/** Consume-time exact owner/source/ACL revalidation; the candidate itself conveys no authority. */
export async function resolveLiveCompanionWorkPublication(
  options: LiveCompanionWorkReadOptions,
  scope: LiveCompanionWorkScope,
  candidate: LiveCompanionWorkCandidate,
): Promise<HomeWorkPublication | null> {
  if (
    !(await inScope(options, scope)) ||
    candidate.destination.threadId !== scope.threadId ||
    !candidate.destination.messageId ||
    !candidate.destination.item ||
    !options.artifactLineage
  )
    return null;
  const messageId = candidate.destination.messageId;
  const message = await currentRead(options, () => options.messages.getById(messageId));
  const rows = publications(message, scope).filter((row) =>
    isDeepStrictEqual(row.publicationItem, candidate.destination.item),
  );
  const resolved = await resolveEvidence(options, scope, rows);
  return resolved.find((row) => isDeepStrictEqual(row.candidate, candidate))?.publication ?? null;
}
