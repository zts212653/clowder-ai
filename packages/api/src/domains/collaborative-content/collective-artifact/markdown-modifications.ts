import {
  collectiveArtifactControlSchema,
  collectiveArtifactProposalSelectionSchema,
  collectiveArtifactReadPageSchema,
  collectiveContentTextProposalReceiptSchema,
  respondCollectiveContentTextSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { collectiveContentScopeRef } from '../../video-studio/content-owner/collective-scope.js';
import type { ProjectContentOwnerService } from '../../video-studio/content-owner/service.js';
import type { ArtifactReviewStore } from '../artifact-review/store.js';
import { applyContentTextEdits } from '../modification/text/text-store.js';
import { WorkspaceContentReviewError } from '../workspace-review/errors.js';
import type { AdmittedCollectiveMarkdown } from './markdown-authority.js';
import { applyCollectiveModification } from './markdown-modification-apply.js';
import { controlCollectiveModification } from './markdown-modification-control.js';
import { projectCollectiveModification, requestCollectiveModification } from './markdown-modification-request.js';
import { pageCollectiveValue } from './markdown-read.js';
import type { CollectiveMarkdownReviews } from './markdown-reviews.js';

const responseSchema = respondCollectiveContentTextSchema.extend({ kind: z.literal('respond-modification') }).strict();
const previewSchema = collectiveArtifactProposalSelectionSchema.merge(collectiveArtifactReadPageSchema).strict();

export class CollectiveMarkdownModifications {
  constructor(
    private readonly stores: {
      owner: ProjectContentOwnerService;
      modifications: ArtifactReviewStore;
      reviews: CollectiveMarkdownReviews;
      ownerUserId: string;
    },
  ) {}

  async prepareDelegatedRequest(admitted: AdmittedCollectiveMarkdown, payload: unknown) {
    if (!admitted.constraint.agent) throw new WorkspaceContentReviewError('access_denied');
    const prepared = await this.stores.reviews.importSelections(admitted, payload);
    return requestCollectiveModification(admitted, prepared, this.stores, true);
  }

  readRequest(admitted: AdmittedCollectiveMarkdown) {
    const agent = admitted.constraint.agent;
    if (!agent) return {};
    const record = this.stores.modifications.requests.collective.forSource(
      collectiveContentScopeRef(admitted.scope),
      agent.requestEventId,
    );
    if (!record) return { modification: { state: 'preparing' } };
    if (
      record.requestingHumanId !== admitted.constraint.humanId ||
      record.target.catId !== agent.catId ||
      record.target.connectionId !== agent.connectionId ||
      record.target.humanId !== agent.humanId ||
      record.source.ownerRevision !== admitted.content.ownerRevision ||
      record.source.blobDigest !== admitted.content.blobDigest
    )
      throw new WorkspaceContentReviewError('access_denied');
    const review = this.stores.reviews.prepare(admitted);
    const latest = this.stores.modifications.text.latestProposal(record.requestId);
    return {
      modification: {
        ...projectCollectiveModification(record),
        instruction: record.instruction,
        latestProposalRevision: latest?.revision ?? 0,
        ...(latest ? { latestProposalRef: latest.proposalRef } : {}),
        ...(record.source.rework
          ? {
              reworkProposal: this.requireProposal(record.source.rework.requestId, record.source.rework.proposalRef),
            }
          : {}),
        selections: review.annotations
          .filter((item) => record.annotationIds.includes(item.id))
          .map((item) => ({
            annotationId: item.id,
            body: item.body,
            anchor: item.anchor,
            author: item.author,
            ownerRevision: item.collectiveMessage?.ownerRevision,
          })),
      },
    };
  }
  readRequests(admitted: AdmittedCollectiveMarkdown, unsafe: Record<string, unknown>) {
    if (admitted.constraint.agent) return this.readRequest(admitted);
    const page = collectiveArtifactReadPageSchema.parse(unsafe);
    const { requests, total, snapshot } = this.stores.modifications.requests.collective.list(
      collectiveContentScopeRef(admitted.scope),
      page.requestOffset,
      page.requestLimit,
    );
    return {
      modifications: {
        total,
        snapshot,
        offset: page.requestOffset,
        ...(page.requestOffset + requests.length < total ? { nextOffset: page.requestOffset + requests.length } : {}),
        requests: requests.map((record) => {
          const proposal = this.stores.modifications.text.latestProposal(record.requestId);
          return {
            ...projectCollectiveModification(record),
            latestProposalRevision: proposal?.revision ?? 0,
            ...(proposal ? { latestProposalRef: proposal.proposalRef } : {}),
          };
        }),
      },
    };
  }

  async propose(admitted: AdmittedCollectiveMarkdown, payload: Record<string, unknown>, replayOnly = false) {
    if (replayOnly && payload.kind !== 'respond-modification') throw new WorkspaceContentReviewError('source_changed');
    if (payload.kind === 'request-modification') {
      const prepared = await this.stores.reviews.importSelections(admitted, payload);
      return {
        request: projectCollectiveModification(await requestCollectiveModification(admitted, prepared, this.stores)),
      };
    }
    const { kind: _kind, ...command } = responseSchema.parse(payload);
    const request = this.requireRequest(admitted, command.requestId);
    const agent = admitted.constraint.agent;
    if (
      !agent ||
      agent.catId !== request.target.catId ||
      agent.humanId !== request.target.humanId ||
      agent.connectionId !== request.target.connectionId ||
      agent.participationRevision !== request.target.participationRevision ||
      agent.requestEventId !== request.source.requestEventId ||
      admitted.constraint.humanId !== request.requestingHumanId
    )
      throw new WorkspaceContentReviewError('access_denied');
    await admitted.authorize();
    const proposal = this.stores.modifications.text.respondOwner(
      command,
      agent.catId,
      {
        scopeRef: request.source.scopeRef,
        contentRef: admitted.content.contentRef,
        ownerRevision: admitted.content.ownerRevision,
        blobDigest: admitted.content.blobDigest,
        text: admitted.content.bytes.toString('utf8'),
      },
      replayOnly,
    );
    return {
      kind: 'proposal-receipt',
      proposal: collectiveContentTextProposalReceiptSchema.strip().parse(proposal),
      request: projectCollectiveModification(this.requireRequest(admitted, request.requestId)),
    };
  }

  async preview(admitted: AdmittedCollectiveMarkdown, payload: Record<string, unknown>) {
    const page = previewSchema.parse(payload);
    const request = this.requireRequest(admitted, page.requestId);
    const proposal = this.requireProposal(request.requestId, page.proposalRef);
    const source = await this.stores.owner.load(admitted.content.contentRef, request.source.ownerRevision);
    if (source.blobDigest !== proposal.baseRevision) throw new WorkspaceContentReviewError('source_changed');
    await admitted.authorize();
    return pageCollectiveValue(
      admitted,
      {
        request: projectCollectiveModification(request),
        proposal,
        baseText: source.bytes.toString('utf8'),
        proposedText: applyContentTextEdits(source.bytes.toString('utf8'), proposal.edits),
        stale: source.ownerRevision !== admitted.content.currentOwnerRevision,
        currentOwnerRevision: admitted.content.currentOwnerRevision,
      },
      page,
    );
  }

  async apply(admitted: AdmittedCollectiveMarkdown, payload: Record<string, unknown>) {
    const selection = collectiveArtifactProposalSelectionSchema.parse(payload);
    const request = this.requireRequest(admitted, selection.requestId);
    const proposal = this.requireProposal(request.requestId, selection.proposalRef);
    const accepted = await applyCollectiveModification(admitted, request, proposal, this.stores);
    return {
      ...accepted,
      lineage: {
        requestId: request.requestId,
        requestEventId: request.source.requestEventId,
        proposalRef: proposal.proposalRef,
        sourceEventId: request.source.sourceEventId,
        sourceOwnerRevision: request.source.ownerRevision,
        location: request.source.location,
      },
    };
  }

  async control(admitted: AdmittedCollectiveMarkdown, payload: Record<string, unknown>) {
    const input = collectiveArtifactControlSchema.parse(payload);
    return controlCollectiveModification(admitted, this.requireRequest(admitted, input.requestId), input, this.stores);
  }

  private requireRequest(admitted: AdmittedCollectiveMarkdown, requestId: string) {
    const record = this.stores.modifications.requests.collective.get(
      requestId,
      collectiveContentScopeRef(admitted.scope),
    );
    if (!record || record.source.contentRef !== admitted.content.contentRef)
      throw new WorkspaceContentReviewError('access_denied');
    return record;
  }
  private requireProposal(requestId: string, proposalRef: string) {
    const proposal = this.stores.modifications.text
      .proposals(requestId)
      .find((item) => item.proposalRef === proposalRef);
    if (!proposal) throw new WorkspaceContentReviewError('source_changed');
    return proposal;
  }
}
