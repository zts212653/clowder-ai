import { type CollectiveArtifactRelayOperation, collectiveArtifactHistoryPageSchema } from '@cat-cafe/shared';
import { ZodError } from 'zod';
import { collectiveContentScopeRef } from '../../video-studio/content-owner/collective-scope.js';
import {
  ContentOwnerConflictError,
  ContentOwnerIdempotencyError,
  type ProjectContentOwnerService,
} from '../../video-studio/content-owner/service.js';
import type { ArtifactReviewStore } from '../artifact-review/store.js';
import { ContentModificationJournalError } from '../modification/journal-errors.js';
import { ModificationTextError } from '../modification/text/text-store.js';
import { WorkspaceContentReviewError } from '../workspace-review/errors.js';
import type { WorkspaceContentReviewStore } from '../workspace-review/store.js';
import { CollectiveArtifactTransferOwner } from './custody-transfer-owner.js';
import {
  type AdmittedCollectiveMarkdown,
  admitCollectiveMarkdown,
  collectiveOwnerDecisionRef,
} from './markdown-authority.js';
import { CollectiveMarkdownModifications } from './markdown-modifications.js';
import { publishCollectiveMarkdown, recoverCollectiveMarkdownPublication } from './markdown-publication.js';
import { readCollectiveMarkdown } from './markdown-read.js';
import { CollectiveMarkdownReviews } from './markdown-reviews.js';
import { recoverCollectiveSettlements } from './markdown-settlement-recovery.js';
import { type CollectiveArtifactOwnerPort, type CollectiveArtifactOwnerResult } from './owner-port.js';
import { CollectiveArtifactScopeQueue } from './scope-serial-queue.js';

export class CollectiveMarkdownOwner implements CollectiveArtifactOwnerPort {
  readonly custody?: CollectiveArtifactTransferOwner;
  private readonly scopeQueue = new CollectiveArtifactScopeQueue();
  private readonly reviews: CollectiveMarkdownReviews;
  private readonly modifications: CollectiveMarkdownModifications;
  constructor(
    private readonly options: {
      owner: ProjectContentOwnerService;
      reviews: WorkspaceContentReviewStore;
      modifications: ArtifactReviewStore;
      ownerUserId: string;
      custodyDataDir?: string;
      onError?: (error: unknown) => void;
    },
  ) {
    this.reviews = new CollectiveMarkdownReviews(options.reviews, options.ownerUserId);
    this.modifications = new CollectiveMarkdownModifications({ ...options, reviews: this.reviews });
    if (options.custodyDataDir)
      this.custody = new CollectiveArtifactTransferOwner(
        { ...options, scopeQueue: this.scopeQueue },
        options.custodyDataDir,
      );
  }
  execute(
    operation: CollectiveArtifactRelayOperation,
    authority: Parameters<CollectiveArtifactOwnerPort['execute']>[1],
  ): Promise<CollectiveArtifactOwnerResult> {
    return this.scopeQueue.run(operation.constraint.contentRef, () => this.executeAdmitted(operation, authority));
  }
  private async executeAdmitted(
    operation: CollectiveArtifactRelayOperation,
    authority: Parameters<CollectiveArtifactOwnerPort['execute']>[1],
  ): Promise<CollectiveArtifactOwnerResult> {
    try {
      const admitted = await admitCollectiveMarkdown(this.options.owner, operation, authority);
      const localFence = await this.options.owner.collectiveCustody.fence.read(admitted.constraint.contentRef);
      const replayOnly =
        Boolean(admitted.constraint.agent) &&
        admitted.constraint.action === 'propose' &&
        (localFence?.state === 'source_frozen' || admitted.constraint.effectMode === 'replay_only');
      const frozen = await this.guardGeneration(admitted, replayOnly);
      const authorize = admitted.authorize;
      admitted.authorize = async () => {
        await authorize();
        await this.guardGeneration(admitted, replayOnly);
      };
      if (!frozen) await this.reviews.reconcileSource(admitted);
      let value: Record<string, unknown>;
      switch (admitted.constraint.action) {
        case 'read': {
          let page = operation.payload;
          if (admitted.constraint.agent) {
            const { sharedRequest, ...parameters } = operation.payload;
            await this.modifications.prepareDelegatedRequest(admitted, sharedRequest);
            page = parameters;
          }
          value = readCollectiveMarkdown(admitted, this.reviews, page, this.modifications.readRequests(admitted, page));
          break;
        }
        case 'history': {
          const page = collectiveArtifactHistoryPageSchema.parse(operation.payload);
          const receipts = await this.options.owner.listOutbox(admitted.content.contentRef);
          value = {
            contentRef: admitted.content.contentRef,
            total: receipts.length,
            ...(page.offset + page.limit < receipts.length ? { nextOffset: page.offset + page.limit } : {}),
            versions: receipts.slice(page.offset, page.offset + page.limit).map((receipt) => ({
              ownerRevision: receipt.ownerRevision,
              blobDigest: receipt.blobDigest,
              receiptRef: receipt.receiptId,
              actor: receipt.actor,
            })),
          };
          break;
        }
        case 'annotate':
          if (operation.payload.kind === 'review-action') value = await this.reviews.act(admitted, operation.payload);
          else if (operation.payload.kind === 'annotate-published-selections') {
            await this.reviews.importSelections(admitted, { ...operation.payload, kind: 'request-modification' });
            value = { view: this.reviews.view(admitted) };
          } else value = await this.reviews.annotate(admitted, operation.payload);
          break;
        case 'propose':
          value = await this.modifications.propose(admitted, operation.payload, replayOnly);
          break;
        case 'preview':
          value = await this.modifications.preview(admitted, operation.payload);
          break;
        case 'apply':
          value = await this.modifications.apply(admitted, operation.payload);
          break;
        case 'cancel':
        case 'reject':
          value = await this.modifications.control(admitted, operation.payload);
          break;
        default:
          return { status: 'error', error: { code: 'invalid_request' } };
      }
      const recovery = await recoverCollectiveSettlements(admitted, this.options);
      if (recovery) value = { ...value, settlementRecovery: recovery };
      await admitted.authorize();
      return { status: 'ok', ownerDecisionRef: collectiveOwnerDecisionRef(admitted), value };
    } catch (error) {
      this.options.onError?.(error);
      return { status: 'error', error: { code: ownerErrorCode(error) } };
    }
  }
  private async guardGeneration(admitted: AdmittedCollectiveMarkdown, replayOnly = false): Promise<boolean> {
    const scopeRef = collectiveContentScopeRef(admitted.scope);
    const { contentRef, custodyRevision, action, agent } = admitted.constraint;
    const fence = this.options.owner.collectiveCustody.fence;
    if (!replayOnly && (agent || ['annotate', 'propose', 'apply', 'cancel', 'reject'].includes(action))) {
      await fence.assertEffectAvailable(contentRef, scopeRef, custodyRevision);
      return false;
    }
    const frozen = await fence.assertReadable(contentRef, scopeRef, custodyRevision);
    if (replayOnly && !frozen) throw new Error('Collective custody replay generation unavailable');
    if (
      frozen &&
      action === 'read' &&
      !this.options.reviews.getByContent(this.options.ownerUserId, contentRef, scopeRef)
    )
      throw new Error('Collective custody frozen ledger unavailable');
    return frozen;
  }
  recoverPublication(publication: Parameters<NonNullable<CollectiveArtifactOwnerPort['recoverPublication']>>[0]) {
    return recoverCollectiveMarkdownPublication(this.options.owner, publication);
  }
  async publish(
    operation: Parameters<NonNullable<CollectiveArtifactOwnerPort['publish']>>[0],
    authority: Parameters<NonNullable<CollectiveArtifactOwnerPort['publish']>>[1],
  ): Promise<CollectiveArtifactOwnerResult> {
    try {
      const value = await publishCollectiveMarkdown(this.options.owner, operation, authority);
      return { status: 'ok', ownerDecisionRef: operation.publication.publicationId, value };
    } catch (error) {
      this.options.onError?.(error);
      return { status: 'error', error: { code: ownerErrorCode(error) } };
    }
  }
}

function ownerErrorCode(error: unknown): 'access_denied' | 'conflict' | 'invalid_request' | 'owner_unavailable' {
  if (error instanceof ContentModificationJournalError) return 'conflict';
  if (error instanceof ModificationTextError) return error.code === 'proposal_changed' ? 'conflict' : 'invalid_request';
  if (error instanceof ZodError || error instanceof RangeError) return 'invalid_request';
  if (error instanceof ContentOwnerConflictError || error instanceof ContentOwnerIdempotencyError) return 'conflict';
  if (error instanceof WorkspaceContentReviewError) {
    if (error.code === 'access_denied') return 'access_denied';
    if (['revision_conflict', 'source_changed', 'operation_reused'].includes(error.code)) return 'conflict';
    return 'invalid_request';
  }
  if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number') {
    const codes: Record<number, 'access_denied' | 'conflict'> = { 403: 'access_denied', 409: 'conflict' };
    return codes[error.statusCode ?? 0] ?? 'owner_unavailable';
  }
  return 'owner_unavailable';
}
