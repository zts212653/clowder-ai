import { isDeepStrictEqual } from 'node:util';
import { entrustedWorkV1Schema, type MessageMediaItemSelector } from '@cat-cafe/shared';
import { readCompanionArtifactLineage } from './companion-work-lineage.js';
import { companionMessagePublications, currentCompanionPublications } from './companion-work-publications.js';
import { type CompanionWorkReadOptions, readCompanionProjectThreads } from './companion-work-read.js';

export type CompanionWorkNavigation = 'applied' | 'queued' | 'blocked' | 'unconfirmed';
export interface CompanionWorkDestination {
  readonly threadId: string;
  readonly taskId?: string;
  readonly messageId?: string;
  readonly item?: MessageMediaItemSelector;
  readonly sourceRef: string;
  readonly artifact?: { readonly contentRef: string; readonly ownerRevision: number };
}

/** Disposable navigation coordinates, never a cached work/status/version record. */
export type CompanionWorkReference =
  | { readonly kind: 'task'; readonly threadId: string; readonly taskId: string }
  | {
      readonly kind: 'publication';
      readonly threadId: string;
      readonly messageId: string;
      readonly item: MessageMediaItemSelector;
    };

async function readTaskDestination(
  options: CompanionWorkReadOptions,
  ref: Extract<CompanionWorkReference, { kind: 'task' }>,
) {
  const task = await options.tasks.get(ref.taskId);
  if (
    !task ||
    task.id !== ref.taskId ||
    task.threadId !== ref.threadId ||
    task.userId !== options.ownerUserId ||
    task.kind !== 'work' ||
    !entrustedWorkV1Schema.safeParse(task.entrustedWork).success
  )
    return null;
  return { threadId: task.threadId, taskId: task.id, sourceRef: `task:work:${task.id}` };
}

async function readPublicationDestination(
  options: CompanionWorkReadOptions,
  ref: Extract<CompanionWorkReference, { kind: 'publication' }>,
) {
  const message = await options.messages.getById(ref.messageId);
  const publication = companionMessagePublications(message, options.ownerUserId, ref.threadId).find(
    (row) => row.sourceMessageId === ref.messageId && isDeepStrictEqual(row.publicationItem, ref.item),
  );
  if (!publication) return null;
  const source = await readCompanionArtifactLineage(
    {
      ownerUserId: options.ownerUserId,
      ...(options.artifactLineage ? { lineage: options.artifactLineage } : {}),
    },
    [publication],
    true,
  );
  const [current] = await currentCompanionPublications(options.messages, options.ownerUserId, source.artifacts);
  if (!current) return null;
  return {
    threadId: current.threadId,
    messageId: ref.messageId,
    item: current.publicationItem,
    sourceRef: `message:${current.threadId}:${ref.messageId}`,
    ...(current.work
      ? { artifact: { contentRef: current.work.contentRef, ownerRevision: current.work.ownerRevision } }
      : {}),
  };
}

/** Exact owner reads let a valid issued card outlive the overview's moving recent window. */
export async function readCompanionWorkDestination(
  options: CompanionWorkReadOptions,
  ref: CompanionWorkReference,
): Promise<CompanionWorkDestination | null> {
  await options.assertCurrent();
  if (!(await readCompanionProjectThreads(options)).has(ref.threadId)) return null;
  const destination =
    ref.kind === 'task' ? await readTaskDestination(options, ref) : await readPublicationDestination(options, ref);
  if (!(await readCompanionProjectThreads(options)).has(ref.threadId)) return null;
  await options.assertCurrent();
  return destination;
}
