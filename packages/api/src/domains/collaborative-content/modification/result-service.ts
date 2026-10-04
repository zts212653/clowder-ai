import type { ContentModificationCandidate, ContentWritebackReceipt } from '@cat-cafe/shared';
import { z } from 'zod';
import type { MediaReviewPrincipal } from '../../video-studio/content-owner/published-media-access.js';
import type { PublishedMediaService } from '../../video-studio/content-owner/published-media-service.js';
import { isWorkspaceTextEditable } from '../../workspace/workspace-text-policy.js';
import { WorkspaceWritebackError } from '../../workspace/writeback/journal.js';
import type { WorkspaceWritebackService, WorkspaceWritebackView } from '../../workspace/writeback/service.js';
import { reviewModificationBindings } from '../artifact-review/modification-request-reference.js';
import type { ArtifactReviewService } from '../artifact-review/service.js';
import type { ArtifactReviewStore } from '../artifact-review/store.js';
import type { ModificationFileLineage } from './file-lineage.js';
import type { ContentModificationRecord } from './journal.js';
import { ContentModificationJournalError } from './journal-errors.js';
import type { ContentTextModificationService } from './text/text-service.js';
import { ModificationTextError } from './text/text-store.js';

const acceptSchema = z
  .object({
    requestId: z.string().min(1).max(256),
    candidateRef: z.string().min(1).max(1000),
    acceptOperationId: z.string().uuid(),
    baseRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    locator: z.object({ worktreeId: z.string().min(1), path: z.string().min(1) }).strict(),
    editSessionToken: z.string().min(1).max(2048),
  })
  .strict();
export type ModificationCandidate = ContentModificationCandidate;

/** Candidate readiness and file effect are different facts. This producer never closes a Task. */
export class ContentModificationResultService {
  constructor(
    private readonly deps: {
      store: ArtifactReviewStore;
      reviews: ArtifactReviewService;
      media: PublishedMediaService;
      text: ContentTextModificationService;
      writer: WorkspaceWritebackService;
      fileLineage: ModificationFileLineage;
    },
  ) {}

  async candidates(
    record: ContentModificationRecord,
    principal: MediaReviewPrincipal,
  ): Promise<ModificationCandidate[]> {
    const bound = record.progress.review;
    if (!bound) return [];
    if (record.progress.prepared?.kind === 'text') {
      const view = await this.deps.text.read(record.requestId, principal);
      return view.proposals.map((proposal) => ({ kind: 'text', candidateRef: proposal.proposalRef, proposal }));
    }
    const view = await this.deps.reviews.readCurrent(bound.reviewId, principal);
    const previous = view.review.rounds.find((round) => round.number === bound.round);
    const bindings = reviewModificationBindings(this.deps.store, view.review);
    const original = bindings.find((item) => item.record.requestId === record.requestId);
    if (!previous || original?.record.progress.review?.receiptRef !== bound.receiptRef)
      throw new ModificationTextError('source_changed');
    const lastResultRound = Math.min(
      Infinity,
      ...bindings
        .filter((item) => item.revision > original.revision)
        .map((item) => item.record.progress.review!.round!),
    );
    const candidates: ModificationCandidate[] = [];
    for (const returned of view.review.rounds.filter(
      (round) => round.number > (bound.round ?? 0) && round.number <= lastResultRound,
    )) {
      if (returned.responseAuthor?.kind !== 'cat' || returned.responseAuthor.actorId !== record.payload.targetCatId)
        throw new ModificationTextError('task_changed');
      const asset = await this.deps.media.read(returned.asset.contentRef, returned.asset.ownerRevision, principal);
      candidates.push({
        kind: 'media',
        candidateRef: asset.ownerReceiptRef,
        asset,
        authorCatId: returned.responseAuthor.actorId,
        responses: returned.responses,
      });
    }
    return candidates;
  }

  async writeback(record: ContentModificationRecord, principal: MediaReviewPrincipal) {
    const origin = await this.deps.fileLineage.origin(record, principal);
    if (!origin) return undefined;
    const source = origin.payload.source;
    const applied: WorkspaceWritebackView[] = [];
    let writable = !this.deps.store.requests.get(record.requestId, principal.userId)?.control;
    for (const related of this.deps.fileLineage.records(origin)) {
      for (const acceptance of this.deps.store.acceptances.list(related.requestId, principal.userId)) {
        const receipt = await this.deps.writer.find(acceptance.fileReceiptRef, principal);
        if (!receipt) continue;
        if (receipt.state === 'applied') applied.push(receipt);
        if (receipt.state === 'unknown' || receipt.state === 'prepared') writable = false;
      }
    }
    const sequenced = applied
      .filter((receipt) => receipt.appliedSequence !== undefined)
      .sort((a, b) => (b.appliedSequence ?? 0) - (a.appliedSequence ?? 0));
    // Before this feature's ordered receipts, one historical effect is unambiguous; multiple are not.
    const latest = sequenced[0] ?? (applied.length === 1 ? applied[0] : undefined);
    if (applied.length > 1 && !latest) writable = false;
    if (record.progress.task) {
      const task = await this.deps.media.access.authorize(record.progress.task.taskId, principal, {
        allowClosed: true,
      });
      if (task.ownerCatId !== record.payload.targetCatId || task.threadId !== record.payload.threadId)
        throw new ModificationTextError('task_changed');
      if (task.status === 'done' || task.entrustedWork?.closure.state !== 'open') writable = false;
    } else writable = false;
    return {
      originRequestId: origin.requestId,
      locator: source.locator,
      baseRevision: latest?.writtenRevision ?? source.expectedSourceRevision,
      writable,
    };
  }

  async accept(raw: unknown, principal: MediaReviewPrincipal) {
    if (principal.actor.kind !== 'human' || principal.actor.actorId !== principal.userId)
      throw new WorkspaceWritebackError('identity_required');
    const command = acceptSchema.parse(raw);
    const record = this.deps.store.requests.get(command.requestId, principal.userId);
    if (!record || !record.progress.task) throw new ModificationTextError('not_found');
    const source = await this.writeback(record, principal);
    if (!source) throw new ModificationTextError('not_found');
    const priorAcceptance = this.deps.store.acceptances
      .list(record.requestId, principal.userId)
      .find((item) => item.acceptOperationId === command.acceptOperationId);
    if (record.control && !priorAcceptance) throw new ContentModificationJournalError('request_cancelled');
    if (
      command.baseRevision !== (priorAcceptance?.baseRevision ?? source.baseRevision) ||
      command.locator.worktreeId !== source.locator.worktreeId ||
      command.locator.path !== source.locator.path
    )
      throw new ModificationTextError('source_changed');
    if (!priorAcceptance && !source.writable) throw new ModificationTextError('source_changed');
    const candidate = (await this.candidates(record, principal)).find(
      (item) => item.candidateRef === command.candidateRef,
    );
    if (!candidate) throw new ModificationTextError('not_found');
    const task = await this.deps.media.access.authorize(record.progress.task.taskId, principal, { allowClosed: true });
    if (task.ownerCatId !== record.payload.targetCatId) throw new ModificationTextError('task_changed');
    if (task.status === 'done' || task.entrustedWork?.closure.state !== 'open') {
      const prior = this.deps.store.acceptances
        .list(record.requestId, principal.userId)
        .find((item) => item.acceptOperationId === command.acceptOperationId);
      if (prior && prior.candidateRef === command.candidateRef) {
        const receipt = await this.deps.writer.find(prior.fileReceiptRef, principal);
        if (receipt?.state === 'applied') return { acceptance: prior, receipt: publicWritebackReceipt(receipt) };
      }
      // This exact file acceptance won before our later request cancellation. Other Task closures still fence new effects.
      if (
        !(
          prior?.candidateRef === command.candidateRef &&
          record.control &&
          task.entrustedWork?.closure.state === 'cancelled' &&
          task.entrustedWork.closure.disposition.dispositionRef === record.control.receiptRef
        )
      )
        throw new ModificationTextError('task_changed');
    }
    let bytes: Buffer;
    if (candidate.kind === 'text') {
      if (!isWorkspaceTextEditable(source.locator.path)) throw new WorkspaceWritebackError('access_denied');
      bytes = (await this.deps.text.candidate(record.requestId, candidate.candidateRef, principal)).bytes;
    } else bytes = await this.deps.media.bytes(candidate.asset.contentRef, candidate.asset.ownerRevision, principal);
    const reserveAcceptance = () =>
      this.deps.store.acceptances.reserve({
        requestId: record.requestId,
        ownerUserId: principal.userId,
        acceptOperationId: command.acceptOperationId,
        candidateRef: command.candidateRef,
        baseRevision: command.baseRevision,
        locator: command.locator,
      });
    // The acceptance and cancel decisions share the journal DB, establishing an exact human-intent order.
    const acceptance = priorAcceptance
      ? reserveAcceptance()
      : this.deps.store.requests.cancellations.unlessCancelled(record.requestId, principal.userId, reserveAcceptance);
    const receipt = await this.deps.writer.accept(
      { ...command, bytes },
      { userId: principal.userId, editSessionToken: command.editSessionToken },
    );
    return { acceptance, receipt: publicWritebackReceipt(receipt) };
  }

  async reject(requestId: string, candidateRef: string, principal: MediaReviewPrincipal) {
    if (principal.actor.kind !== 'human' || principal.actor.actorId !== principal.userId)
      throw new WorkspaceWritebackError('identity_required');
    const record = this.deps.store.requests.get(requestId, principal.userId);
    if (!record || !(await this.writeback(record, principal))) throw new ModificationTextError('not_found');
    const candidate = (await this.candidates(record, principal)).find((item) => item.candidateRef === candidateRef);
    if (!candidate) throw new ModificationTextError('not_found');
    return this.deps.store.requests.cancellations.unlessCancelled(requestId, principal.userId, () => {
      const old = this.rejections(requestId, principal.userId).find((item) => item.candidateRef === candidateRef);
      if (old) return old;
      const rejection = this.deps.store.acceptances.reject(requestId, principal.userId, candidateRef);
      this.deps.store.requests.noteHumanDecision(requestId, principal.userId);
      return rejection;
    });
  }

  rejections(requestId: string, ownerUserId: string) {
    return this.deps.store.acceptances.rejections(requestId, ownerUserId);
  }

  async acceptances(record: ContentModificationRecord, principal: MediaReviewPrincipal) {
    if (principal.userId !== record.ownerUserId) throw new ModificationTextError('not_found');
    const results = [];
    for (const acceptance of this.deps.store.acceptances.list(record.requestId, principal.userId)) {
      try {
        results.push({
          acceptance,
          receipt: publicWritebackReceipt(await this.deps.writer.read(acceptance.fileReceiptRef, principal)),
        });
      } catch (error) {
        if (!(error instanceof WorkspaceWritebackError) || error.code !== 'access_denied') throw error;
        results.push({ acceptance, receipt: null });
      }
    }
    return results;
  }
}

export function publicWritebackReceipt(receipt: WorkspaceWritebackView): ContentWritebackReceipt {
  const { targetPath: _path, proof: _proof, fingerprint: _fingerprint, ...visible } = receipt;
  return visible;
}
