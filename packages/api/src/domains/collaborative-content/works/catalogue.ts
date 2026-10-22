import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { WorkListReader } from './catalogue-read.js';
import type { WorkContextStore } from './context-store.js';
import type { LivingWorkService } from './service.js';

export interface IndependentWorkCataloguePort {
  withRead?<T>(ownerUserId: string, consume: (reader: IndependentWorkCataloguePort) => Promise<T>): Promise<T>;
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
  withRead<T>(ownerUserId: string, consume: (reader: IndependentWorkCataloguePort) => Promise<T>) {
    return this.service.withCatalogueRead(ownerUserId, (reader) =>
      consume({ readThread: (input) => this.readThreadFrom(reader, input) }),
    );
  }
  async readThread(input: { ownerUserId: string; threadId: string; after?: string; snapshot?: string }) {
    return this.readThreadFrom(this.service, input);
  }
  private async readThreadFrom(
    service: WorkListReader,
    input: Parameters<IndependentWorkCataloguePort['readThread']>[0],
  ) {
    const page = await service.list(
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
  return withIndependentWorksRead(port, ownerUserId, async (reader) => {
    if (!reader) return [];
    const artifacts: ThreadArtifactDTO[] = [];
    let after: string | undefined;
    let snapshot: string | undefined;
    do {
      const page = await reader.readThread({ ownerUserId, threadId, after, snapshot });
      artifacts.push(...page.artifacts);
      if (page.nextCursor === after && after) throw new MediaOwnerError('media_unavailable');
      after = page.nextCursor;
      snapshot = page.snapshot;
    } while (after);
    return artifacts;
  });
}

export function withIndependentWorksRead<T>(
  port: IndependentWorkCataloguePort | undefined,
  ownerUserId: string,
  consume: (reader: IndependentWorkCataloguePort | undefined) => Promise<T>,
): Promise<T> {
  return port?.withRead ? port.withRead(ownerUserId, consume) : consume(port);
}
