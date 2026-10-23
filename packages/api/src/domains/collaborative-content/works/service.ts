import { createHash } from 'node:crypto';
import {
  type CommitWork,
  commitWorkSchema,
  type ImmutableMedia,
  type WorkCommand,
  type WorkReference,
  type WorkWorkspaceSource,
  workReferenceCardSchema,
  workReferenceSchema,
} from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import { workPublicationContentRef } from '../../video-studio/content-owner/publication.js';
import {
  ContentOwnerConflictError,
  ContentOwnerIdempotencyError,
  ContentOwnerNotFoundError,
  type ProjectContentOwnerService,
} from '../../video-studio/content-owner/service.js';
import type { ContentStream } from '../../video-studio/content-owner/stream-content.js';
import {
  type ContentSettlementReceiptV1,
  type ContentSourcePublicationV1,
  isWorkPublicationScope,
  type WorkPublicationScopeV1,
} from '../../video-studio/content-owner/types.js';
import { type WorkListReader, withWorkCatalogueRead } from './catalogue-read.js';
import type { WorkCatalogueReadObserver } from './catalogue-read-timing.js';
import type { WorkReviewResponseService } from './review-response.js';
import type { WorkAuthorizationInput, WorkPrincipal, WorkReadResult } from './types.js';
import { workVersionRecord } from './version-record.js';
import type { WorkVersionStore } from './version-store.js';

export type { WorkAuthorizationInput, WorkPrincipal } from './types.js';

export interface OpenWorkSource extends ContentStream {
  readonly mediaType: 'video/mp4';
  /** F063 probes the same frozen snapshot used by this stream; review admission must require this clock. */
  readonly media?: ImmutableMedia;
  readonly publication: ContentSourcePublicationV1;
  readonly revalidate: () => Promise<void>;
}
export interface WorkSourcePort {
  open(input: { source: WorkWorkspaceSource; principal: WorkPrincipal; threadId: string }): Promise<OpenWorkSource>;
  inspect(input: { locator: Omit<WorkWorkspaceSource, 'expectedSourceRevision'>; principal: WorkPrincipal }): Promise<{
    source: WorkWorkspaceSource;
    mediaType: string;
    byteLength: number;
    media?: ImmutableMedia;
  }>;
}

export class WorkProjectionPendingError extends Error {
  constructor(
    readonly receipt: ContentSettlementReceiptV1,
    options: ErrorOptions,
  ) {
    super('Work version saved; annotations pending recovery', options);
  }
}

/** A shared submission coordinator: saved owner effect and recoverable F309 annotations, never a second head. */
export class LivingWorkService {
  constructor(
    private readonly deps: {
      owner: ProjectContentOwnerService;
      versions: WorkVersionStore;
      source: WorkSourcePort;
      responses?: WorkReviewResponseService;
      changed?(ownerUserId: string): void;
      authorize(input: WorkAuthorizationInput): Promise<void>;
    },
  ) {}

  async commit(raw: unknown, principal: WorkPrincipal) {
    const result = await this.commitVersion(raw, principal);
    try {
      this.deps.changed?.(principal.userId);
    } catch {
      /* Projection invalidation never changes the canonical save result. */
    }
    return result;
  }

  private async commitVersion(raw: unknown, principal: WorkPrincipal) {
    const command = commitWorkSchema.parse(raw);
    const response = command.action === 'submit' ? command.reviewResponse : undefined;
    if (response && !this.deps.responses) throw new MediaOwnerError('media_unavailable');
    await this.deps.authorize({ principal, permission: 'write' });
    const contentRef = command.action === 'submit' ? command.contentRef : createdWorkRef(command, principal);
    const current = await this.describeExisting(contentRef);
    const scope = current?.publicationScope;
    if (current && !isWorkPublicationScope(scope)) throw new MediaOwnerError('access_denied');
    const workScope: WorkPublicationScopeV1 = isWorkPublicationScope(scope)
      ? scope
      : {
          kind: 'work',
          ownerUserId: principal.userId,
          threadId: principal.threadId,
          creationOperationId: command.operationId,
          createdBy: principal.actor,
        };
    if (!workScope.threadId) throw new MediaOwnerError('access_denied');
    await this.deps.authorize({ principal, permission: 'write', scope: workScope });
    const requestDigest = sha(JSON.stringify(command));
    const previous = current
      ? (await this.deps.owner.listOutbox(contentRef)).find((item) => item.operationId === command.operationId)
      : undefined;
    if (previous) {
      assertWorkReplay(command, principal, previous, requestDigest);
      if (command.action === 'submit' && response) {
        try {
          return await this.deps.responses!.project(command, principal, workScope, previous, requestDigest);
        } catch (cause) {
          throw new WorkProjectionPendingError(previous, { cause });
        }
      }
      return this.project(command, workScope, previous, requestDigest);
    }
    if (command.action === 'submit' && current?.currentOwnerRevision !== command.expectedOwnerRevision)
      throw new ContentOwnerConflictError(
        contentRef,
        command.expectedOwnerRevision,
        current?.currentOwnerRevision ?? 0,
      );
    const opened = await this.deps.source.open({ source: command.source, principal, threadId: workScope.threadId });
    try {
      if (command.action === 'submit' && current?.blobDigest === opened.blobDigest)
        throw new MediaOwnerError('publication_changed');
      const pending =
        command.action === 'submit' && response
          ? await this.deps.responses!.reserve(command, principal, workScope, opened, requestDigest)
          : undefined;
      const authorizeEffect = async () => {
        await opened.revalidate();
        await this.deps.authorize({ principal, permission: 'write', scope: workScope });
        if (pending) await this.deps.responses!.assertEffect(pending, principal);
      };
      const mutation = {
        ...opened,
        contentRef,
        operationId: command.operationId,
        actor: principal.actor,
        sourcePublication: { ...opened.publication, threadId: workScope.threadId },
        authorizeEffect,
        operationContext: { kind: `work:${command.action}` as 'work:create' | 'work:submit', requestDigest },
      };
      const receipt =
        command.action === 'create'
          ? await this.deps.owner.importStream({ ...mutation, publicationScope: workScope })
          : await this.deps.owner.settleStream({ ...mutation, expectedOwnerRevision: command.expectedOwnerRevision });
      if (command.action === 'submit' && response) {
        try {
          return await this.deps.responses!.project(command, principal, workScope, receipt, requestDigest);
        } catch (cause) {
          throw new WorkProjectionPendingError(receipt, { cause });
        }
      }
      return this.project(command, workScope, receipt, requestDigest);
    } finally {
      opened.stream.destroy();
    }
  }

  async resolveReviewSubmission(
    command: Extract<WorkCommand, { action: 'resolve-review-submission' }>,
    principal: WorkPrincipal,
  ) {
    await this.deps.authorize({ principal, permission: 'read' });
    if (!this.deps.responses) throw new MediaOwnerError('media_unavailable');
    return this.deps.responses.resolve(command, principal);
  }

  async read(raw: WorkReference, principal: WorkPrincipal): Promise<WorkReadResult> {
    const reference = workReferenceSchema.parse(raw);
    const description = await this.deps.owner.describe(reference.contentRef, reference.ownerRevision);
    const scope = description.publicationScope;
    if (!isWorkPublicationScope(scope)) throw new MediaOwnerError('access_denied');
    await this.deps.authorize({ principal, permission: 'read', scope });
    const version = this.deps.versions.get(principal.userId, reference.contentRef, reference.ownerRevision);
    if (!version) throw new MediaOwnerError('media_unavailable');
    const revision = await this.deps.owner.describeRevision(reference.contentRef, reference.ownerRevision);
    await this.deps.authorize({ principal, permission: 'read', scope });
    return { reference, currentOwnerRevision: description.currentOwnerRevision, version, description, revision };
  }

  async reference(raw: WorkReference, principal: WorkPrincipal) {
    const { reference, version } = await this.read(raw, principal);
    const block = workReferenceCardSchema.parse({
      id: `work-reference-${sha(JSON.stringify(reference)).slice(7, 31)}`,
      v: 1,
      kind: 'card',
      title: version.title,
      bodyMarkdown: version.changeSummary,
      meta: { kind: 'work_reference', reference },
    });
    return { reference, block };
  }

  async list(principal: WorkPrincipal, after?: string, expectedSnapshot?: string, threadFilter?: string) {
    return this.withCatalogueRead(principal.userId, (reader) =>
      reader.list(principal, after, expectedSnapshot, threadFilter),
    );
  }

  withCatalogueRead<T>(
    ownerUserId: string,
    consume: (reader: WorkListReader) => Promise<T>,
    observer?: WorkCatalogueReadObserver,
  ): Promise<T> {
    return withWorkCatalogueRead({ ...this.deps, read: this.read.bind(this) }, ownerUserId, consume, observer);
  }

  async inspectSource(locator: Omit<WorkWorkspaceSource, 'expectedSourceRevision'>, principal: WorkPrincipal) {
    await this.deps.authorize({ principal, permission: 'write' });
    const description = await this.deps.source.inspect({ locator, principal });
    await this.deps.authorize({ principal, permission: 'write' });
    return description;
  }

  async authorizeVersion(reference: WorkReference, principal: WorkPrincipal, permission: 'read' | 'write') {
    const current = await this.read(reference, principal);
    const scope = current.description.publicationScope;
    if (!isWorkPublicationScope(scope)) throw new MediaOwnerError('access_denied');
    await this.deps.authorize({ principal, permission, scope });
  }

  private async describeExisting(contentRef: string) {
    try {
      return await this.deps.owner.describe(contentRef);
    } catch (error) {
      if (error instanceof ContentOwnerNotFoundError) return null;
      throw error;
    }
  }

  private project(
    command: CommitWork,
    scope: WorkPublicationScopeV1,
    receipt: ContentSettlementReceiptV1,
    requestDigest: `sha256:${string}`,
  ) {
    const reference = { contentRef: receipt.contentRef, ownerRevision: receipt.ownerRevision };
    try {
      const version = this.deps.versions.recordVersion(workVersionRecord(command, scope, receipt, requestDigest));
      return { status: 'saved' as const, reference, receipt, version };
    } catch (cause) {
      throw new WorkProjectionPendingError(receipt, { cause });
    }
  }
}

function sha(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
function assertWorkReplay(
  command: CommitWork,
  principal: WorkPrincipal,
  previous: ContentSettlementReceiptV1,
  requestDigest: string,
) {
  if (
    previous.operationContext?.kind !== `work:${command.action}` ||
    previous.operationContext.requestDigest !== requestDigest ||
    previous.actor.kind !== principal.actor.kind ||
    previous.actor.actorId !== principal.actor.actorId
  )
    throw new ContentOwnerIdempotencyError(previous.contentRef, command.operationId);
}
function createdWorkRef(command: CommitWork, principal: WorkPrincipal) {
  return workPublicationContentRef({
    kind: 'work',
    ownerUserId: principal.userId,
    createdBy: principal.actor,
    threadId: principal.threadId,
    creationOperationId: command.operationId,
  });
}
