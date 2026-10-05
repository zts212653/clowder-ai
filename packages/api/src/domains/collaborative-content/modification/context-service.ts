import type {
  ContentModificationContextCatalogue,
  ContentModificationRecord,
  ContentModificationRequest,
} from '@cat-cafe/shared';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { MediaReviewPrincipal } from '../../video-studio/content-owner/published-media-access.js';
import type { PublishedMediaService } from '../../video-studio/content-owner/published-media-service.js';
import { ArtifactReviewError } from '../artifact-review/errors.js';
import type { ArtifactReviewService } from '../artifact-review/service.js';
import type { ArtifactReviewStore } from '../artifact-review/store.js';
import type { WorkspaceContentReviewService } from '../workspace-review/service.js';
import { cancelledModificationReplacement } from './control/supersession.js';
import { inspectEvolutionModification } from './evolution-binding.js';
import { readLegacyModificationSource } from './legacy-review-binding.js';
import { assertModificationSourceAuthority } from './request-authority.js';
import type { ContentModificationService } from './service.js';

type Context = ContentModificationContextCatalogue['contexts'][number];
type Source = ContentModificationRequest['source'];
type Labels = Awaited<ReturnType<typeof assertModificationSourceAuthority>>;

/** Discovers actual persisted custody; no current-cat defaults, URL joins, or fake Tasks. */
export class ContentModificationContextService {
  constructor(
    private readonly deps: {
      store: ArtifactReviewStore;
      files: WorkspaceContentReviewService;
      ledgers: WorkspaceContentReviewService;
      media: PublishedMediaService;
      reviews: ArtifactReviewService;
      requests: ContentModificationService;
      messages: Pick<IMessageStore, 'getById'>;
    },
  ) {}

  async read(source: Source, principal: MediaReviewPrincipal): Promise<ContentModificationContextCatalogue> {
    if (principal.actor.kind !== 'human' || principal.actor.actorId !== principal.userId)
      throw new MediaOwnerError('access_denied');
    const suggestedCatId = await this.authorizeSource(source, principal);
    const result: ContentModificationContextCatalogue = {
      requests: [],
      contexts: [],
      ...(suggestedCatId ? { suggestedCatId } : {}),
    };
    for (const record of this.deps.store.requests.forSource(principal.userId, source)) {
      try {
        const labels = record.progress.sourceMessageId
          ? await assertModificationSourceAuthority(this.deps.messages, record)
          : undefined;
        const request = await this.deps.requests.read(record.requestId, principal);
        const context = await this.context(record, source, principal, labels);
        result.requests.push(request);
        if (!context) continue;
        const prior = result.contexts.find((item) => item.taskId === context.taskId);
        if (prior) prior.requestIds.push(record.requestId);
        else result.contexts.push(context);
      } catch (error) {
        // An inaccessible historical binding is not an alternate authorization route.
        if (
          (error instanceof MediaOwnerError || error instanceof ArtifactReviewError) &&
          ['access_denied', 'not_found', 'task_changed', 'task_closed', 'publication_changed'].includes(error.code)
        )
          continue;
        throw error;
      }
    }
    return result;
  }

  private async authorizeSource(source: Source, principal: MediaReviewPrincipal): Promise<string | undefined> {
    if (source.kind === 'artifact-review') {
      const { view } = await readLegacyModificationSource(this.deps.reviews, source, principal);
      return view.authority.ownerCatId ?? undefined;
    }
    if (source.kind === 'evolution') {
      await inspectEvolutionModification(this.deps.ledgers, source, principal, true);
      return;
    }
    if (source.kind === 'workspace') {
      await this.deps.files.describeSource({ principal, reviewId: source.reviewId, locator: source.locator });
      return;
    }
    const ledger = await this.deps.ledgers.read({ principal, reviewId: source.ledgerRef });
    if (
      ledger.review.source.kind !== 'publication' ||
      ledger.review.source.publication.contentRef !== source.contentRef ||
      ledger.review.source.publication.ownerRevision !== source.ownerRevision
    )
      throw new ArtifactReviewError('asset_changed');
    const { origin } = await this.deps.media.describe(source.contentRef, source.ownerRevision, principal);
    return 'publisherCatId' in origin ? origin.publisherCatId : undefined;
  }

  private async context(
    record: ContentModificationRecord,
    source: Source,
    principal: MediaReviewPrincipal,
    labels: Labels | undefined,
  ): Promise<Context | null> {
    if (!record.progress.task) return null;
    const task = await this.deps.media.access.authorize(record.progress.task.taskId, principal, { allowClosed: true });
    if (
      !task.entrustedWork ||
      task.ownerCatId !== record.payload.targetCatId ||
      task.threadId !== record.payload.threadId
    )
      throw new ArtifactReviewError('task_changed');
    const context: Context = {
      taskId: task.id,
      title: task.title,
      targetCatId: task.ownerCatId,
      threadId: task.threadId,
      targetName: labels?.targetName ?? '原具名猫',
      threadTitle: labels?.executionThreadTitle ?? '原执行对话',
      ...(labels ? { completionRule: labels.completionRule } : {}),
      requestIds: [record.requestId],
      state: task.status !== 'done' && task.entrustedWork.closure.state === 'open' ? 'active' : 'closed',
    };
    if (record.progress.prepared?.kind === 'text' && context.state === 'active' && source.kind === 'workspace')
      context.taskContext = { kind: 'text', taskId: task.id, expectedTaskRevision: task.entrustedWork.revision };
    if (record.progress.prepared?.kind === 'media' && record.progress.review)
      await this.mediaContext(context, record.progress.review.reviewId, source, principal, task.entrustedWork.revision);
    return context;
  }

  private async mediaContext(
    context: Context,
    reviewId: string,
    source: Source,
    principal: MediaReviewPrincipal,
    taskRevision: number,
  ) {
    const view = await this.deps.reviews.readCurrent(reviewId, principal);
    const round = view.review.rounds.at(-1);
    if (!round) return;
    context.publication = { contentRef: round.asset.contentRef, ownerRevision: round.asset.ownerRevision };
    if (
      context.state !== 'active' ||
      !view.authority.canWrite ||
      (!['draft', 'awaiting_human'].includes(round.state) &&
        !cancelledModificationReplacement(this.deps.store, view.review, round.number)) ||
      !(
        (source.kind === 'publication' &&
          source.contentRef === round.asset.contentRef &&
          source.ownerRevision === round.asset.ownerRevision) ||
        (source.kind === 'artifact-review' && source.reviewId === view.review.reviewId && source.round === round.number)
      )
    )
      return;
    context.taskContext = {
      kind: 'media',
      taskId: context.taskId,
      expectedTaskRevision: taskRevision,
      reviewId: view.review.reviewId,
      expectedReviewRevision: view.review.revision,
      round: round.number,
    };
  }
}
