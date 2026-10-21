import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { WorkContextStore } from './context-store.js';
import type { LivingWorkService } from './service.js';

export interface IndependentWorkCataloguePort {
  readThread(input: { ownerUserId: string; threadId: string; after?: string; snapshot?: string }): Promise<{
    artifacts: ThreadArtifactDTO[];
    snapshot: string;
    nextCursor?: string;
  }>;
}

/** F232 projection of F138's current works and F309's version annotations, including silent saves. */
export class WorkCatalogue implements IndependentWorkCataloguePort {
  constructor(
    private readonly service: LivingWorkService,
    private readonly contexts?: Pick<WorkContextStore, 'get'>,
  ) {}
  async readThread(input: { ownerUserId: string; threadId: string; after?: string; snapshot?: string }) {
    const page = await this.service.list(
      { userId: input.ownerUserId, threadId: input.threadId, actor: { kind: 'human', actorId: input.ownerUserId } },
      input.after,
      input.snapshot,
      input.threadId,
    );
    const artifacts = page.items.map((item): ThreadArtifactDTO => {
      const createdAt = Date.parse(item.revision.committedAt);
      if (!Number.isFinite(createdAt)) throw new MediaOwnerError('media_unavailable');
      // List has already authorized these exact owner versions. Metadata changes no pagination coordinates.
      const production = this.contexts?.get(input.ownerUserId, item.reference)?.context.production;
      return {
        type: item.description.mediaType === 'video/mp4' ? 'video' : 'file',
        name: item.version.title,
        catId: item.revision.committedBy.kind === 'cat' ? item.revision.committedBy.actorId : null,
        createdAt,
        sourceMessageId: null,
        ref: item.reference.contentRef,
        url: `/api/content-publications/${encodeURIComponent(item.reference.contentRef)}/media/${item.reference.ownerRevision}`,
        work: {
          ...item.reference,
          currentOwnerRevision: item.currentOwnerRevision,
          ...(production
            ? { versionCreatedAt: Date.parse(production.createdAt), versionTimeSource: production.sourceRef }
            : {}),
        },
      };
    });
    return { artifacts, snapshot: page.snapshot, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }
}

export async function readIndependentThreadWorks(
  port: IndependentWorkCataloguePort | undefined,
  ownerUserId: string,
  threadId: string,
) {
  if (!port) return [];
  const artifacts: ThreadArtifactDTO[] = [];
  let after: string | undefined;
  let snapshot: string | undefined;
  do {
    const page = await port.readThread({ ownerUserId, threadId, after, snapshot });
    artifacts.push(...page.artifacts);
    if (page.nextCursor === after && after) throw new MediaOwnerError('media_unavailable');
    after = page.nextCursor;
    snapshot = page.snapshot;
  } while (after);
  return artifacts;
}
