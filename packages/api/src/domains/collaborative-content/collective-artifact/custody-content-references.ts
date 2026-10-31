import { isDeepStrictEqual } from 'node:util';
import type {
  CollectiveModificationRecord,
  WorkspaceContentAnnotation,
  WorkspaceContentReview,
} from '@cat-cafe/shared';
import type { CollectiveContentSnapshot } from '../../video-studio/content-owner/collective-snapshot.js';
import { digestBytes } from '../../video-studio/content-owner/store.js';
import { workspaceTextAnchorAt } from '../../workspace/workspace-content-text-resolver.js';
import type { CollectiveModificationSnapshot } from '../modification/collective-custody-snapshot.js';
import { applyContentTextEdits } from '../modification/text/patch.js';
import type { CollectiveWorkspaceSnapshot } from '../workspace-review/collective-custody-snapshot.js';

type Request = Omit<CollectiveModificationRecord, 'execution'>;
/** One verified immutable version index serves ledger, request selection and candidate validation. */
export class CollectiveCustodyContentReferences {
  private readonly versions: Map<number, { digest: string; bytes: Buffer; text: string }>;
  constructor(private readonly content: CollectiveContentSnapshot) {
    const blobs = new Map(content.blobs.map((item) => [item.digest, Buffer.from(item.base64, 'base64')]));
    this.versions = new Map(
      content.manifest.revisions.map((item) => {
        const bytes = blobs.get(item.blobDigest);
        if (!bytes) throw new Error('Collective transfer references a missing blob');
        return [item.ownerRevision, { digest: item.blobDigest, bytes, text: bytes.toString('utf8') }];
      }),
    );
  }
  private version(ownerRevision: number, digest: string) {
    const version = this.versions.get(ownerRevision);
    if (!version || version.digest !== digest)
      throw new Error('Collective transfer references a missing owner version');
    return version;
  }
  validateLedger(snapshot: CollectiveWorkspaceSnapshot) {
    this.validateReview(snapshot.review);
    for (const review of snapshot.retained) this.validateReview(review);
    for (const operation of snapshot.operations)
      if (operation.generation === 'result') this.validateReview(operation.review);
  }
  private validateReview(ledger: WorkspaceContentReview) {
    const scope = this.content.manifest.collectiveScope;
    if (
      ledger.collaborationScope?.serviceInstanceId !== scope.serviceInstanceId ||
      ledger.collaborationScope.collectiveId !== scope.collectiveId ||
      ledger.collaborationScope.artifactId !== scope.artifactId
    )
      throw new Error('Collective ledger coordinates mismatch');
    for (const source of [ledger.source, ...(ledger.sourceHistory ?? [])])
      if (
        source.kind !== 'collective-artifact' ||
        this.version(source.ownerRevision, source.revision).bytes.byteLength !== source.byteLength
      )
        throw new Error('Collective ledger version mismatch');
    for (const annotation of ledger.annotations) this.validateAnnotation(annotation);
  }
  private validateAnnotation(annotation: WorkspaceContentAnnotation) {
    const message = annotation.collectiveMessage;
    const anchor = annotation.anchor;
    if (!message || !('kind' in anchor) || anchor.kind !== 'text_quote')
      throw new Error('Collective annotation source mismatch');
    const source = this.version(message.ownerRevision, message.blobDigest);
    const expected = workspaceTextAnchorAt(source.text, anchor.start, anchor.end);
    const { kind: _kind, baseRevision: _revision, ...quote } = anchor;
    if (!isDeepStrictEqual(expected, quote)) throw new Error('Collective annotation quote mismatch');
  }
  validateModifications(snapshot: CollectiveModificationSnapshot, review: WorkspaceContentReview | null) {
    const requests = new Map(snapshot.requests.map((item) => [item.requestId, item]));
    for (const request of snapshot.requests) {
      const rework = request.source.rework;
      const prior = rework && requests.get(rework.requestId);
      if (
        rework &&
        (!prior ||
          prior.source.ownerRevision >= request.source.ownerRevision ||
          !isDeepStrictEqual(prior.annotationIds, request.annotationIds) ||
          !snapshot.proposals.some(
            (row) => row.requestId === prior.requestId && row.proposal.proposalRef === rework.proposalRef,
          ))
      )
        throw new Error('Collective rework candidate reference mismatch');
      this.validateRequest(request, review);
    }
    for (const row of snapshot.proposals) {
      const request = requests.get(row.requestId);
      if (!request) throw new Error('Collective proposal request missing');
      const source = this.version(request.source.ownerRevision, request.source.blobDigest);
      const candidate = Buffer.from(applyContentTextEdits(source.text, row.proposal.edits));
      if (candidate.byteLength > 65536 || digestBytes(candidate) !== row.proposal.resultRevision)
        throw new Error('Collective proposal bytes mismatch');
    }
  }
  private validateRequest(request: Request, review: WorkspaceContentReview | null) {
    const scope = this.content.manifest.collectiveScope;
    const source = request.source;
    if (
      !review ||
      request.ownerUserId !== review.ownerUserId ||
      source.ledgerRef !== review.reviewId ||
      source.ledgerRevision > review.revision ||
      source.serviceInstanceId !== scope.serviceInstanceId ||
      source.collectiveId !== scope.collectiveId ||
      source.artifactId !== scope.artifactId ||
      source.sourceEventId !== scope.sourceEventId ||
      request.state === 'running'
    )
      throw new Error('Collective request lineage mismatch or execution is active');
    this.version(source.ownerRevision, source.blobDigest);
    for (const annotationId of request.annotationIds) this.validateSelection(annotationId, source, review);
  }
  private validateSelection(annotationId: string, source: Request['source'], review: WorkspaceContentReview) {
    const annotation = review.annotations.find((item) => item.id === annotationId);
    if (
      !annotation ||
      (!source.rework && annotation.collectiveMessage?.ownerRevision !== source.ownerRevision) ||
      (!source.rework && annotation.anchor.baseRevision !== source.blobDigest) ||
      !annotation.collectiveMessage ||
      annotation.collectiveMessage.channelId !== source.location.channelId ||
      annotation.collectiveMessage.rootEventId !==
        (source.location.rootEventId ?? this.content.manifest.collectiveScope.sourceEventId)
    )
      throw new Error('Collective request selection mismatch');
  }
}
