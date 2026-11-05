import { createHash } from 'node:crypto';
import { type VideoProjectDocumentV1, videoProjectDocumentSchema } from '@cat-cafe/shared';
import { videoProjectMediaType } from '../content-owner/project-scope.js';
import {
  ContentOwnerIdempotencyError,
  ContentOwnerNotFoundError,
  type ProjectContentOwnerService,
} from '../content-owner/service.js';
import type { ContentSettlementReceiptV1, VideoContentOperationContextV1 } from '../content-owner/types.js';
import {
  type AuthorizeVideoProjectCat,
  VideoProjectAccess,
  VideoProjectAccessError,
  type VideoProjectPrincipal,
} from './access.js';
import type { VideoProjectAssetIndex } from './asset-index.js';
import { assertCheckResultsBoundToInput } from './check-results.js';
import {
  applyVideoProjectDecision,
  replayVideoProjectDecision,
  type VideoProjectDecisionCommand,
} from './decisions.js';
import {
  assertNewCheckResults,
  assertOpaqueExtensionsPreserved,
  assertProjectDecisions,
  assertProjectHistoryPreserved,
  projectValueDigest,
  sameProjectValue,
} from './document-mutations.js';
import { prepareScreeningCommand, prepareSelfReviewCommand } from './registration-command.js';
import { assertProjectRegistrationFacts } from './registration-facts.js';
import type { AppendVideoProjectScreening } from './screening-types.js';
import type { AppendVideoProjectSelfReview } from './self-review.js';
import type { VideoProjectReadPort, VideoProjectSnapshot } from './types.js';

export type { VideoProjectPrincipal } from './access.js';
export type { VideoProjectSnapshot } from './types.js';
export interface SaveVideoProjectInput {
  readonly principal: VideoProjectPrincipal;
  readonly contentRef: string;
  readonly expectedOwnerRevision: number;
  readonly operationId: string;
  readonly document: unknown;
}

/** F138's typed facade. Content-owner is the only head/revision/receipt authority. */
export class VideoProjectService implements VideoProjectReadPort {
  private readonly access: VideoProjectAccess;
  private readonly now: () => string;
  constructor(
    private readonly options: {
      readonly owner: ProjectContentOwnerService;
      readonly ownerUserId: string;
      readonly authorizeCat?: AuthorizeVideoProjectCat;
      readonly assets?: Pick<VideoProjectAssetIndex, 'inspect' | 'read'>;
      readonly now?: () => string;
    },
  ) {
    this.access = new VideoProjectAccess(options.ownerUserId, options.authorizeCat);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async create(input: { principal: VideoProjectPrincipal; operationId: string; document: unknown }) {
    const projectId = createHash('sha256').update(`${this.options.ownerUserId}\0${input.operationId}`).digest('hex');
    const contentRef = `video-project:${projectId}`;
    await this.access.assert(input.principal, contentRef, 'write');
    const document = parseDocument(input.document);
    assertProjectRegistrationFacts(undefined, document);
    if (document.archivedAt) throw new Error('A new project starts active');
    assertCheckResultsBoundToInput(document, document.checkResults, 1);
    assertProjectDecisions(undefined, document, input.principal.actor, this.options.ownerUserId, input.operationId);
    // An exact retry replays its frozen import even when an external source later changed.
    let exists = false;
    try {
      await this.options.owner.describe(contentRef);
      exists = true;
    } catch (error) {
      if (!(error instanceof ContentOwnerNotFoundError)) throw error;
    }
    if (!exists) await this.assertNewAssetVersions(document);
    return this.options.owner.importContent({
      contentRef,
      bytes: encodeDocument(document),
      mediaType: videoProjectMediaType,
      operationId: input.operationId,
      actor: input.principal.actor,
      operationContext: operationContext('video-project:create', document),
      projectScope: { kind: 'video-project', ownerUserId: this.options.ownerUserId, projectId },
    });
  }

  async authorize(input: { principal: VideoProjectPrincipal; contentRef: string; permission: 'read' | 'write' }) {
    await this.access.assert(input.principal, input.contentRef, input.permission);
    const metadata = await this.options.owner.describe(input.contentRef);
    if (metadata.projectScope?.ownerUserId !== input.principal.userId || metadata.mediaType !== videoProjectMediaType)
      throw new VideoProjectAccessError('Video project access denied: project scope mismatch');
    // Scope metadata is another owner await; do not carry an earlier accepted Task across it into a write.
    if (input.permission === 'write') await this.access.assert(input.principal, input.contentRef, input.permission);
  }

  async load(input: {
    principal: VideoProjectPrincipal;
    contentRef: string;
    ownerRevision?: number;
  }): Promise<VideoProjectSnapshot> {
    await this.authorize({ ...input, permission: 'read' });
    const content = await this.options.owner.load(input.contentRef, input.ownerRevision);
    return {
      contentRef: content.contentRef,
      ownerRevision: content.ownerRevision,
      blobDigest: content.blobDigest,
      document: parseDocument(JSON.parse(content.bytes.toString('utf8'))),
    };
  }

  async list(input: { principal: VideoProjectPrincipal; includeArchived?: boolean }) {
    await this.access.assert(input.principal, 'video-project:*', 'read');
    const projects = [];
    for (const entry of await this.options.owner.listVideoProjects(this.options.ownerUserId)) {
      const snapshot = await this.load({ principal: input.principal, contentRef: entry.contentRef });
      if (input.includeArchived || !snapshot.document.archivedAt) projects.push(snapshot);
    }
    return projects;
  }

  async save(input: SaveVideoProjectInput): Promise<ContentSettlementReceiptV1> {
    return this.persist(input);
  }

  async appendScreening(input: Parameters<AppendVideoProjectScreening>[0]): Promise<ContentSettlementReceiptV1> {
    await this.authorize({ ...input, permission: 'write' });
    const prepared = await prepareScreeningCommand(this.options.owner, this, input);
    return (
      prepared.receipt ??
      this.persist({ ...input, document: prepared.document }, undefined, false, prepared.context, 'screening')
    );
  }

  async appendSelfReview(input: Parameters<AppendVideoProjectSelfReview>[0]): Promise<ContentSettlementReceiptV1> {
    await this.authorize({ ...input, permission: 'write' });
    const prepared = await prepareSelfReviewCommand(this, input);
    return (
      prepared.receipt ??
      this.persist({ ...input, document: prepared.document }, undefined, false, prepared.context, 'self-review')
    );
  }

  async operationReceipt(input: { principal: VideoProjectPrincipal; contentRef: string; operationId: string }) {
    await this.authorize({ ...input, permission: 'read' });
    return (await this.options.owner.listOutbox(input.contentRef)).find(
      (receipt) => receipt.operationId === input.operationId,
    );
  }

  async readAsset(input: {
    principal: VideoProjectPrincipal;
    contentRef: string;
    ownerRevision?: number;
    assetVersionRef: string;
  }) {
    const snapshot = await this.load(input);
    const version = snapshot.document.assets
      .flatMap((asset) => asset.versions)
      .find((candidate) => candidate.id === input.assetVersionRef);
    if (!version || !this.options.assets) throw new Error('Asset access unavailable');
    return this.options.assets.read(version);
  }

  async decide(input: VideoProjectDecisionCommand): Promise<ContentSettlementReceiptV1> {
    await this.authorize({ ...input, permission: 'write' });
    if (input.principal.actor.kind !== 'human') throw new Error('Only the project Human owner can decide');
    const context = operationContext('video-project:decision', {
      decisionId: input.decisionId,
      action: input.action,
      optionId: input.optionId,
      answer: input.answer,
      reason: input.reason,
    });
    const replay = await this.operationReceipt(input);
    if (replay) {
      const saved = await this.load({ ...input, ownerRevision: replay.ownerRevision });
      if (
        !sameProjectValue(replay.operationContext, context) ||
        !replayVideoProjectDecision(input, replay, saved.document)
      )
        throw new ContentOwnerIdempotencyError(input.contentRef, input.operationId);
      return replay;
    }
    const base = await this.load({ ...input, ownerRevision: input.expectedOwnerRevision });
    return this.persist(
      { ...input, document: applyVideoProjectDecision(input, base.document, this.now()) },
      input.decisionId,
      false,
      context,
    );
  }

  async archive(input: Omit<SaveVideoProjectInput, 'document'> & { archived: boolean }) {
    if (typeof input.archived !== 'boolean') throw new Error('Archive requires a Boolean state');
    const context = operationContext('video-project:archive', { archived: input.archived });
    await this.authorize({ ...input, permission: 'write' });
    const replay = await this.operationReceipt(input);
    if (replay) {
      const saved = await this.load({ ...input, ownerRevision: replay.ownerRevision });
      if (
        !sameProjectValue(replay.operationContext, context) ||
        Boolean(saved.document.archivedAt) !== input.archived ||
        replay.previousOwnerRevision !== input.expectedOwnerRevision ||
        replay.actor.kind !== input.principal.actor.kind ||
        replay.actor.actorId !== input.principal.actor.actorId
      )
        throw new ContentOwnerIdempotencyError(input.contentRef, input.operationId);
      return replay;
    }
    const base = await this.load({ ...input, ownerRevision: input.expectedOwnerRevision });
    const document = structuredClone(base.document);
    if (input.archived) document.archivedAt = this.now();
    else delete document.archivedAt;
    return this.persist({ ...input, document }, undefined, true, context);
  }

  private async persist(
    input: SaveVideoProjectInput,
    transitionDecisionId?: string,
    archiveCommand = false,
    context?: VideoContentOperationContextV1,
    registrationCommand?: 'screening' | 'self-review',
  ) {
    await this.authorize({ ...input, permission: 'write' });
    const document = parseDocument(input.document);
    const previous = await this.load({ ...input, ownerRevision: input.expectedOwnerRevision });
    const replay = await this.operationReceipt(input);
    if (!replay) {
      const head = await this.load(input);
      if (head.document.archivedAt && !archiveCommand) throw new Error('Archived project is read-only');
    }
    if (!archiveCommand && document.archivedAt !== previous.document.archivedAt)
      throw new Error('Use archive/restore to change project availability');
    assertProjectRegistrationFacts(previous.document, document, registrationCommand);
    assertProjectHistoryPreserved(previous.document, document);
    assertOpaqueExtensionsPreserved(previous.document, document);
    assertProjectDecisions(
      previous.document,
      document,
      input.principal.actor,
      this.options.ownerUserId,
      input.operationId,
      transitionDecisionId,
    );
    assertNewCheckResults(previous.document, document, previous.ownerRevision);
    if (!replay) await this.assertNewAssetVersions(document, previous.document);
    return this.options.owner.settle({
      contentRef: input.contentRef,
      expectedOwnerRevision: input.expectedOwnerRevision,
      bytes: encodeDocument(document),
      actor: input.principal.actor,
      operationId: input.operationId,
      operationContext: context ?? operationContext('video-project:save', document),
    });
  }

  private async assertNewAssetVersions(document: VideoProjectDocumentV1, previous?: VideoProjectDocumentV1) {
    const known = new Set(previous?.assets.flatMap((asset) => asset.versions.map((version) => version.id)) ?? []);
    for (const version of document.assets.flatMap((asset) => asset.versions)) {
      if (known.has(version.id)) continue;
      if (!this.options.assets) throw new Error('Asset indexing authority unavailable');
      const observed = await this.options.assets.inspect(version.locator);
      if (
        observed.sha256 !== version.sha256 ||
        observed.byteLength !== version.byteLength ||
        observed.locator.path !== version.locator.path
      )
        throw new Error('Asset index does not match exact source bytes');
    }
  }
}
function parseDocument(value: unknown): VideoProjectDocumentV1 {
  return videoProjectDocumentSchema.parse(value);
}
function encodeDocument(document: VideoProjectDocumentV1): Buffer {
  const bytes = Buffer.from(JSON.stringify(document));
  if (bytes.byteLength > 16 * 1024 * 1024) throw new Error('Video project document exceeds size limit');
  return bytes;
}

function operationContext(
  kind: VideoContentOperationContextV1['kind'],
  request: unknown,
): VideoContentOperationContextV1 {
  return { kind, requestDigest: projectValueDigest(request) };
}
