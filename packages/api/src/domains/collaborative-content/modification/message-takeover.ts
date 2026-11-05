import {
  type ContentModificationRecord,
  type ContentModificationRequest,
  type ContentModificationTakeover,
  ContextAttachmentSchema,
  contentModificationRequestContractSchema,
  type QuoteContextAttachment,
  type WorkspaceFileQuoteSource,
} from '@cat-cafe/shared';
import {
  deriveGrowingSourceMessageRevision,
  type IMessageStore,
  isDelivered,
  type StoredMessage,
} from '../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../cats/services/stores/ports/TaskStore.js';
import type { MediaReviewPrincipal } from '../../video-studio/content-owner/published-media-access.js';
import {
  WorkspaceContentSourceError,
  type WorkspaceContentSourceService,
} from '../../workspace/workspace-content-source.js';
import { isWorkspaceTextEditable } from '../../workspace/workspace-text-policy.js';
import type { WorkspaceContentReviewService } from '../workspace-review/service.js';
import { workspaceReviewIdentity } from '../workspace-review/workspace-review-anchors.js';
import type { ContentModificationJournal } from './journal.js';
import { type MediaMessageTakeoverDeps, resolveMediaMessagePayload } from './media-message/media-message-takeover.js';
import type { ResolvedMessageTakeover } from './message/types.js';
import type { ProjectMessageTakeoverPort } from './project/types.js';
import { ModificationTextError } from './text/text-store.js';

type CatPrincipal = MediaReviewPrincipal & {
  actor: { kind: 'cat'; actorId: string };
  threadId: string;
  /** Server-authenticated child identity; a parent or a caller-supplied id cannot expose queued work. */
  readonly invocationId?: string;
};
type WorkspaceQuote = QuoteContextAttachment & { source: WorkspaceFileQuoteSource };

export type { ResolvedMessageTakeover } from './message/types.js';

/** The callback contributes only source identity; every authority/content coordinate is read from owner truth. */
export async function resolveMessageTakeover(
  deps: {
    messages: Pick<IMessageStore, 'getById'>;
    source: Pick<WorkspaceContentSourceService, 'describe' | 'resolveRenderedTextSelections'>;
    files: Pick<WorkspaceContentReviewService, 'ensureTextReviewFromMessageTakeover'>;
    requests: Pick<ContentModificationJournal, 'forSource'>;
    tasks: Pick<ITaskStore, 'get'>;
    media?: MediaMessageTakeoverDeps;
    project?: ProjectMessageTakeoverPort;
  },
  input: ContentModificationTakeover,
  principal: CatPrincipal,
  existing?: ContentModificationRecord,
): Promise<ResolvedMessageTakeover> {
  const message = await deps.messages.getById(input.sourceMessageId);
  assertTakeoverSource(message, principal);
  const sourceMessageRevision = deriveGrowingSourceMessageRevision(message) as `sha256:${string}`;
  const sourceVisibility =
    message.visibility === 'whisper'
      ? ({ visibility: 'whisper', whisperTo: [...new Set(message.whisperTo ?? [])] } as const)
      : ({ visibility: 'public' } as const);
  const attachments = (message.contentBlocks ?? [])
    .filter((block) => block.type === 'context_attachment')
    .map((block) => ContextAttachmentSchema.parse(block.attachment));
  const selected = input.attachmentId ? attachments.filter((item) => item.id === input.attachmentId) : attachments;
  if (input.attachmentId && (selected.length !== 1 || selected[0]?.kind !== 'media'))
    throw new ModificationTextError('invalid_patch');
  if (existing?.payload.source.kind === 'video-project') {
    if (!deps.project) throw new ModificationTextError('invalid_patch');
    return deps.project.resolve(input, principal, existing);
  }
  if (existing) {
    if (
      existing.progress.sourceKind !== 'human_message' ||
      existing.progress.sourceMessageId !== input.sourceMessageId ||
      existing.progress.sourceAttachmentId !== input.attachmentId ||
      existing.progress.sourceMessageRevision !== sourceMessageRevision
    )
      throw new ModificationTextError('source_changed');
    return { payload: existing.payload, sourceMessageRevision, sourceVisibility };
  }
  if (attachments.some((item) => item.kind === 'project-screening')) {
    if (!deps.project || attachments.some((item) => item.kind === 'media' || item.kind === 'quote'))
      throw new ModificationTextError('invalid_patch');
    return deps.project.resolve(input, principal);
  }
  const media = selected.filter((item) => item.kind === 'media');
  if (media.length) {
    if (!deps.media || attachments.some((item) => item.kind === 'quote' && item.source.kind === 'workspace_file'))
      throw new ModificationTextError('invalid_patch');
    const payload = await resolveMediaMessagePayload(deps.media, media, message, input.operationId, principal);
    const current = await deps.messages.getById(input.sourceMessageId);
    assertTakeoverSource(current, principal);
    if (deriveGrowingSourceMessageRevision(current) !== sourceMessageRevision)
      throw new ModificationTextError('source_changed');
    return { payload, sourceMessageRevision, sourceVisibility };
  }
  const quotes = workspaceQuotes(message);
  if (quotes.length === 0) throw new ModificationTextError('invalid_patch');
  const firstSource = quotes[0]?.source;
  if (!firstSource?.worktreeId || !firstSource.revision) throw new ModificationTextError('source_changed');
  for (const quote of quotes) {
    if (
      quote.source.worktreeId !== firstSource.worktreeId ||
      quote.source.path !== firstSource.path ||
      quote.source.revision !== firstSource.revision
    )
      throw new ModificationTextError('invalid_patch');
  }
  const locator = { worktreeId: firstSource.worktreeId, path: firstSource.path };
  const ownerPrincipal = { userId: principal.userId };
  const description = await deps.source.describe({ principal: ownerPrincipal, locator });
  if (description.kind !== 'text' || !isWorkspaceTextEditable(description.locator.path))
    throw new WorkspaceContentSourceError('unsupported_text');
  if (description.revision !== firstSource.revision) throw new ModificationTextError('source_changed');
  const reviewId = workspaceReviewIdentity(principal.userId, description.contentRef);
  const selections = [];
  const batch = await deps.source.resolveRenderedTextSelections({
    principal: ownerPrincipal,
    locator,
    expectedRevision: firstSource.revision,
    quotes: quotes.map((quote) => quote.text),
  });
  for (const [index, quote] of quotes.entries()) {
    const resolved = batch.resolutions[index];
    if (resolved.status !== 'attached') throw new ModificationTextError('source_changed');
    selections.push({
      id: quote.id,
      selection: { kind: 'text_quote' as const, baseRevision: batch.source.revision, ...resolved.anchor },
      ...(quote.comment ? { instruction: quote.comment } : {}),
    });
  }
  const modificationSource = {
    kind: 'workspace' as const,
    locator,
    expectedSourceRevision: firstSource.revision,
    reviewId,
    expectedReviewRevision: 1,
  };
  const taskContext = await existingTextTaskContext(deps, modificationSource, principal);
  const payload = contentModificationRequestContractSchema.parse({
    operationId: input.operationId,
    targetCatId: principal.actor.actorId,
    threadId: principal.threadId,
    source: modificationSource,
    intent: { body: message.content, selection: selections[0]?.selection, selections },
    ...(taskContext ? { taskContext } : {}),
  });
  const review = await deps.files.ensureTextReviewFromMessageTakeover({
    principal,
    locator,
    expectedSourceRevision: firstSource.revision,
    expectedContentRef: description.contentRef,
    operationId: input.operationId,
    preparationSource: {
      kind: 'human_message',
      threadId: principal.threadId,
      messageId: input.sourceMessageId,
      messageRevision: sourceMessageRevision,
    },
    assertCurrentAuthority: async () => {
      const current = await deps.messages.getById(input.sourceMessageId);
      assertTakeoverSource(current, principal);
      if (deriveGrowingSourceMessageRevision(current) !== sourceMessageRevision)
        throw new ModificationTextError('source_changed');
    },
  });
  return {
    sourceMessageRevision,
    sourceVisibility,
    payload: { ...payload, source: { ...modificationSource, expectedReviewRevision: review.revision } },
  };
}

async function existingTextTaskContext(
  deps: {
    requests: Pick<ContentModificationJournal, 'forSource'>;
    tasks: Pick<ITaskStore, 'get'>;
  },
  source: Extract<ContentModificationRequest['source'], { kind: 'workspace' }>,
  principal: CatPrincipal,
): Promise<ContentModificationRequest['taskContext'] | undefined> {
  const matches = new Map<string, { taskId: string; expectedTaskRevision: number; kind: 'text' }>();
  for (const record of deps.requests.forSource(principal.userId, source)) {
    const ref = record.progress.task;
    if (
      !ref ||
      record.progress.prepared?.kind !== 'text' ||
      record.payload.targetCatId !== principal.actor.actorId ||
      record.payload.threadId !== principal.threadId
    )
      continue;
    const task = await deps.tasks.get(ref.taskId);
    if (
      !task?.entrustedWork ||
      task.userId !== principal.userId ||
      task.threadId !== principal.threadId ||
      task.ownerCatId !== principal.actor.actorId ||
      task.status === 'done' ||
      task.entrustedWork.closure.state !== 'open'
    )
      continue;
    matches.set(task.id, { kind: 'text', taskId: task.id, expectedTaskRevision: task.entrustedWork.revision });
  }
  if (matches.size > 1) throw new ModificationTextError('task_changed');
  return matches.values().next().value;
}

function assertTakeoverSource(
  message: StoredMessage | null,
  principal: CatPrincipal,
): asserts message is StoredMessage {
  if (
    !message ||
    message.userId !== principal.userId ||
    message.threadId !== principal.threadId ||
    message.catId !== null ||
    message.source !== undefined ||
    message.sourceParseFailure ||
    message.recall ||
    message.deletedAt !== undefined ||
    message._tombstone ||
    !isDelivered(message) ||
    !message.mentions.some((catId) => catId === principal.actor.actorId) ||
    (message.visibility === 'whisper' && !message.whisperTo?.some((catId) => catId === principal.actor.actorId))
  )
    throw new ModificationTextError('not_found');
}

function workspaceQuotes(message: StoredMessage): WorkspaceQuote[] {
  const quotes: WorkspaceQuote[] = [];
  for (const block of message.contentBlocks ?? []) {
    if (block.type !== 'context_attachment') continue;
    const parsed = ContextAttachmentSchema.safeParse(block.attachment);
    if (!parsed.success) throw new ModificationTextError('invalid_patch');
    const attachment = parsed.data;
    if (attachment.kind === 'quote' && attachment.source.kind === 'workspace_file') {
      quotes.push({ ...attachment, source: attachment.source });
    }
  }
  return quotes;
}
