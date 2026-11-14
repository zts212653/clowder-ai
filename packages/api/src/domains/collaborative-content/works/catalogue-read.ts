import { createHash } from 'node:crypto';
import type { WorkReference } from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { ProjectContentOwnerService } from '../../video-studio/content-owner/service.js';
import type { RetainedMediaHead } from '../../video-studio/content-owner/store.js';
import type { WorkPublicationScopeV1 } from '../../video-studio/content-owner/types.js';
import { isWorkPublicationScope } from '../../video-studio/content-owner/types.js';
import { createWorkCatalogueReadTiming, type WorkCatalogueReadObserver } from './catalogue-read-timing.js';
import type { WorkAuthorizationInput, WorkPrincipal, WorkReadResult } from './types.js';

export interface WorkListReader {
  recent?(principal: WorkPrincipal, threadIds: readonly string[], limit: number): Promise<WorkReadResult[]>;
  list(
    principal: WorkPrincipal,
    after?: string,
    expectedSnapshot?: string,
    threadFilter?: string,
  ): Promise<{
    items: WorkReadResult[];
    snapshot: string;
    nextCursor?: string;
  }>;
}

interface Dependencies {
  owner: Pick<ProjectContentOwnerService, 'retainedMediaHeads' | 'retainedThreadMediaHeads'>;
  authorize(input: WorkAuthorizationInput): Promise<void>;
  read(reference: WorkReference, principal: WorkPrincipal): Promise<WorkReadResult>;
}

/** Request-local discovery only. Every page reauthorizes; successful consumption validates fresh owner manifests. */
export async function withWorkCatalogueRead<T>(
  deps: Dependencies,
  ownerUserId: string,
  consume: (reader: WorkListReader) => Promise<T>,
  observer?: WorkCatalogueReadObserver,
): Promise<T> {
  const timing = createWorkCatalogueReadTiming(observer);
  let outcome: 'success' | 'failed' = 'failed';
  const catalogues = new Map<string | undefined, Promise<RetainedMediaHead[]>>();
  const catalogueFor = (threadId?: string) => {
    let catalogue = catalogues.get(threadId);
    if (!catalogue) {
      catalogue = timing
        .measure('discovery', () => readHeads(deps.owner, ownerUserId, threadId))
        .then((heads) => {
          timing.counts.heads += heads.length;
          return heads;
        });
      catalogues.set(threadId, catalogue);
    }
    return catalogue;
  };
  const returned: { principal: WorkPrincipal; scope: WorkPublicationScopeV1 }[] = [];
  let active = true;
  const reader: WorkListReader = {
    async recent(principal, threadIds, limit) {
      if (!active || principal.userId !== ownerUserId) throw new MediaOwnerError('access_denied');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512) throw new TypeError('Invalid recent Work limit');
      await timing.measure('admission', () => deps.authorize({ principal, permission: 'read' }));
      timing.counts.pages++;
      const pending = new Set(threadIds).values();
      const heads: RetainedMediaHead[] = [];
      const reads = await Promise.allSettled(
        Array.from({ length: Math.min(4, threadIds.length) }, async () => {
          for (const threadId of pending) heads.push(...(await catalogueFor(threadId)));
        }),
      );
      reads.forEach((result) => {
        if (result.status === 'rejected') throw result.reason;
      });
      const visible = new Set(
        (await timing.measure('visibility', () => visibleHeads(deps, heads, principal, new Set(threadIds)))).map(
          (item) => item.contentRef,
        ),
      );
      const candidates = heads.filter((head) => visible.has(head.contentRef) && head.committedBy.kind === 'cat');
      if (candidates.some((head) => !Number.isFinite(Date.parse(head.committedAt))))
        throw new MediaOwnerError('media_unavailable');
      candidates.sort(
        (a, b) =>
          Date.parse(b.committedAt) - Date.parse(a.committedAt) ||
          a.publicationScope.threadId.localeCompare(b.publicationScope.threadId) ||
          a.contentRef.localeCompare(b.contentRef),
      );
      const selected = candidates.slice(0, limit);
      timing.counts.selectedVersions += selected.length;
      const items = await timing.measure('selectedVersions', () => readSelectedVersions(deps, selected, principal));
      for (const item of items) {
        const scope = item.description.publicationScope;
        if (!isWorkPublicationScope(scope)) throw new MediaOwnerError('access_denied');
        await deps.authorize({ principal, permission: 'read', scope });
        returned.push({ principal, scope });
        timing.counts.returned++;
      }
      return items;
    },
    async list(principal, after, expectedSnapshot, threadFilter) {
      if (!active || principal.userId !== ownerUserId) throw new MediaOwnerError('access_denied');
      await timing.measure('admission', () => deps.authorize({ principal, permission: 'read' }));
      timing.counts.pages++;
      const heads = await catalogueFor(threadFilter);
      const visible = await timing.measure('visibility', () => visibleHeads(deps, heads, principal, threadFilter));
      const snapshot = `sha256:${createHash('sha256').update(JSON.stringify(visible)).digest('hex')}`;
      if ((after && !expectedSnapshot) || (expectedSnapshot && expectedSnapshot !== snapshot))
        throw new MediaOwnerError('publication_changed');
      const remaining = visible.filter((item) => !after || item.contentRef.localeCompare(after) > 0);
      const page = remaining.slice(0, 10);
      timing.counts.selectedVersions += page.length;
      const items = await timing.measure('selectedVersions', () => readSelectedVersions(deps, page, principal));
      for (const item of items) {
        const scope = item.description.publicationScope;
        if (!isWorkPublicationScope(scope)) throw new MediaOwnerError('access_denied');
        await deps.authorize({ principal, permission: 'read', scope });
        returned.push({ principal, scope });
        timing.counts.returned++;
      }
      return { items, snapshot, ...(remaining.length > page.length ? { nextCursor: page.at(-1)?.contentRef } : {}) };
    },
  };
  try {
    const result = await consume(reader);
    for (const [threadId, catalogue] of catalogues) {
      if (
        JSON.stringify(await catalogue) !==
        JSON.stringify(await timing.measure('manifestValidation', () => readHeads(deps.owner, ownerUserId, threadId)))
      )
        throw new MediaOwnerError('publication_changed');
    }
    await timing.measure('finalAuthorization', async () => {
      for (const { principal, scope } of returned) await deps.authorize({ principal, permission: 'read', scope });
    });
    outcome = 'success';
    return result;
  } finally {
    active = false;
    timing.finish(outcome);
  }
}

/** A failed version cannot close the request scope while sibling source reads are still running. */
async function readSelectedVersions(
  deps: Dependencies,
  references: readonly WorkReference[],
  principal: WorkPrincipal,
) {
  const results = await Promise.allSettled(
    references.map(({ contentRef, ownerRevision }) => deps.read({ contentRef, ownerRevision }, principal)),
  );
  return results.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}

async function visibleHeads(
  deps: Dependencies,
  heads: readonly RetainedMediaHead[],
  principal: WorkPrincipal,
  threadFilter?: string | ReadonlySet<string>,
) {
  const visible: WorkReference[] = [];
  for (const head of heads) {
    const scope = head.publicationScope;
    if (!isWorkPublicationScope(scope)) continue;
    if (
      typeof threadFilter === 'string'
        ? scope.threadId !== threadFilter
        : threadFilter && !threadFilter.has(scope.threadId)
    )
      continue;
    try {
      await deps.authorize({ principal, permission: 'read', scope });
      visible.push({ contentRef: head.contentRef, ownerRevision: head.ownerRevision });
    } catch (error) {
      if (error instanceof MediaOwnerError && error.code === 'access_denied') continue;
      throw error;
    }
  }
  return visible;
}

async function readHeads(owner: Dependencies['owner'], ownerUserId: string, threadId?: string) {
  const heads: RetainedMediaHead[] = [];
  const source =
    threadId === undefined
      ? owner.retainedMediaHeads(ownerUserId, true)
      : owner.retainedThreadMediaHeads(ownerUserId, threadId);
  for await (const head of source) {
    heads.push(head);
    if (heads.length > 10000) throw new MediaOwnerError('media_unavailable');
  }
  return heads.sort((a, b) => a.contentRef.localeCompare(b.contentRef));
}
