import { isDeepStrictEqual } from 'node:util';
import type { WorkspaceContentReview, WorkspaceContentReviewReceipt } from '@cat-cafe/shared';
import type {
  WorkspaceContentLocatorV1,
  WorkspaceContentSourceService,
} from '../../workspace/workspace-content-source.js';
import { isWorkspaceTextEditable } from '../../workspace/workspace-text-policy.js';
import { WorkspaceContentReviewError } from './errors.js';
import type { WorkspaceReviewPrincipal } from './service.js';
import type { WorkspaceContentReviewStore, WorkspaceReviewMutation } from './store.js';
import { validateWorkspaceReviewId, workspaceReviewIdentity } from './workspace-review-anchors.js';
import { type ResolvedWorkspaceSource, resolveWorkspaceCurrentSource } from './workspace-review-source.js';

/** The shared canonical constructor; creation stays synchronous with its durable receipt. */
export function prepareCanonicalWorkspaceReview(
  store: WorkspaceContentReviewStore,
  resolved: ResolvedWorkspaceSource,
  input: {
    principal: WorkspaceReviewPrincipal;
    operationId: string;
    request: unknown;
    preparationSource?: WorkspaceReviewMutation['preparationSource'];
    collaborationScope?: WorkspaceContentReview['collaborationScope'];
  },
  now: string,
): WorkspaceContentReview {
  const operationId = validateWorkspaceReviewId(input.operationId);
  const existing = store.getByContent(input.principal.userId, resolved.contentRef, input.collaborationScope?.scopeRef);
  if (existing) {
    if (!isDeepStrictEqual(existing.collaborationScope, input.collaborationScope))
      throw new WorkspaceContentReviewError('access_denied');
    return existing;
  }
  const review: WorkspaceContentReview = {
    version: 1,
    reviewId: workspaceReviewIdentity(input.principal.userId, resolved.contentRef, input.collaborationScope?.scopeRef),
    ...(input.collaborationScope ? { collaborationScope: input.collaborationScope } : {}),
    ownerUserId: input.principal.userId,
    contentRef: resolved.contentRef,
    source: resolved.source,
    sourceHistory: [resolved.source],
    revision: 1,
    annotations: [],
    createdAt: now,
    updatedAt: now,
  };
  return store.create(review, {
    operationId,
    actor: input.principal.actor,
    now,
    kind: 'prepare',
    request: input.request,
    ...(input.preparationSource ? { preparationSource: input.preparationSource } : {}),
  });
}

export interface MessageTakeoverReviewPreparation {
  readonly principal: WorkspaceReviewPrincipal & { actor: { kind: 'cat'; actorId: string }; threadId: string };
  readonly locator: WorkspaceContentLocatorV1;
  readonly expectedSourceRevision: string;
  readonly expectedContentRef: string;
  readonly operationId: string;
  readonly preparationSource: NonNullable<WorkspaceContentReviewReceipt['preparationSource']>;
  /** All Human identity/visibility/revision fences must be re-read immediately before first write. */
  readonly assertCurrentAuthority: () => Promise<void>;
}

/** Internal capability only. Public prepare/mutation routes continue to require a Human. */
export async function prepareWorkspaceReviewFromMessage(
  owners: { store: WorkspaceContentReviewStore; source: WorkspaceContentSourceService },
  input: MessageTakeoverReviewPreparation,
  now: () => string,
): Promise<WorkspaceContentReview> {
  if (input.principal.actor.kind !== 'cat' || input.principal.threadId !== input.preparationSource.threadId)
    throw new WorkspaceContentReviewError('access_denied');
  validateWorkspaceReviewId(input.operationId);
  validateWorkspaceReviewId(input.preparationSource.messageId);
  const resolved = await resolveWorkspaceCurrentSource(owners.source, {
    userId: input.principal.userId,
    locator: input.locator,
  });
  if (
    resolved.source.kind !== 'text' ||
    !isWorkspaceTextEditable(resolved.source.locator.path) ||
    resolved.contentRef !== input.expectedContentRef ||
    resolved.source.revision !== input.expectedSourceRevision
  )
    throw new WorkspaceContentReviewError('source_changed');
  await input.assertCurrentAuthority();
  const existing = owners.store.getByContent(input.principal.userId, resolved.contentRef);
  if (existing && (existing.source.kind !== 'text' || existing.source.revision !== input.expectedSourceRevision))
    throw new WorkspaceContentReviewError('source_changed');
  // No asynchronous gap between the final Human fence and the store's synchronous transaction.
  return prepareCanonicalWorkspaceReview(
    owners.store,
    resolved,
    {
      principal: input.principal,
      operationId: input.operationId,
      request: { locator: input.locator, preparationSource: input.preparationSource },
      preparationSource: input.preparationSource,
    },
    now(),
  );
}
