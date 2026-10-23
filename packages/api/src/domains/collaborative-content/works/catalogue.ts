import type { GlobalArtifactDTO, ThreadArtifactDTO } from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { WorkListReader } from './catalogue-read.js';
import type { WorkCatalogueReadObserver } from './catalogue-read-timing.js';
import type { WorkContextStore } from './context-store.js';
import type { LivingWorkService } from './service.js';
import type { WorkReadResult } from './types.js';

export interface IndependentWorkCataloguePort {
  withRead?<T>(
    ownerUserId: string,
    consume: (reader: IndependentWorkCataloguePort) => Promise<T>,
    observer?: WorkCatalogueReadObserver,
  ): Promise<T>;
  readRecent?(input: { ownerUserId: string; threadTitles: ReadonlyMap<string, string>; limit: number }): Promise<{
    artifacts: GlobalArtifactDTO[];
    complete: boolean;
  }>;
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
  withRead<T>(
    ownerUserId: string,
    consume: (reader: IndependentWorkCataloguePort) => Promise<T>,
    observer?: WorkCatalogueReadObserver,
  ) {
    return this.service.withCatalogueRead(
      ownerUserId,
      (reader) =>
        consume({
          readThread: (input) => this.readThreadFrom(reader, input),
          readRecent: (input) => this.readRecentFrom(reader, input),
        }),
      observer,
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
    const artifacts = page.items.map((item) => this.project(item, input.ownerUserId));
    return { artifacts, snapshot: page.snapshot, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }
  async readRecent(input: NonNullable<Parameters<NonNullable<IndependentWorkCataloguePort['readRecent']>>[0]>) {
    return this.service.withCatalogueRead(input.ownerUserId, (reader) => this.readRecentFrom(reader, input));
  }
  private async readRecentFrom(
    service: WorkListReader,
    input: Parameters<NonNullable<IndependentWorkCataloguePort['readRecent']>>[0],
  ) {
    const threadId = input.threadTitles.keys().next().value;
    if (!threadId) return { artifacts: [], complete: true };
    if (!service.recent) throw new MediaOwnerError('media_unavailable');
    const items = await service.recent(
      { userId: input.ownerUserId, threadId, actor: { kind: 'human', actorId: input.ownerUserId } },
      [...input.threadTitles.keys()],
      input.limit,
    );
    const artifacts: GlobalArtifactDTO[] = items.map((item) => {
      const scope = item.description.publicationScope;
      if (!scope || !('kind' in scope) || scope.kind !== 'work') throw new MediaOwnerError('access_denied');
      const threadTitle = input.threadTitles.get(scope.threadId);
      if (threadTitle === undefined) throw new MediaOwnerError('access_denied');
      return {
        ...this.project(item, input.ownerUserId),
        threadId: scope.threadId,
        threadTitle,
      };
    });
    return { artifacts, complete: true };
  }
  private project(item: WorkReadResult, ownerUserId: string): ThreadArtifactDTO {
    const createdAt = Date.parse(item.revision.committedAt);
    if (!Number.isFinite(createdAt)) throw new MediaOwnerError('media_unavailable');
    // List has already authorized these exact owner versions. Metadata changes no pagination coordinates.
    const production = this.contexts?.get(ownerUserId, item.reference)?.context.production;
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
  observer?: WorkCatalogueReadObserver,
): Promise<T> {
  return port?.withRead ? port.withRead(ownerUserId, consume, observer) : consume(port);
}
