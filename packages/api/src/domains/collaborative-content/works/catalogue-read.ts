import { createHash } from 'node:crypto';
import type { WorkReference } from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { ProjectContentOwnerService } from '../../video-studio/content-owner/service.js';
import type { RetainedMediaHead } from '../../video-studio/content-owner/store.js';
import type { WorkPublicationScopeV1 } from '../../video-studio/content-owner/types.js';
import { isWorkPublicationScope } from '../../video-studio/content-owner/types.js';
import type { WorkAuthorizationInput, WorkPrincipal, WorkReadResult } from './types.js';

export interface WorkListReader {
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
  owner: Pick<ProjectContentOwnerService, 'retainedMediaHeads'>;
  authorize(input: WorkAuthorizationInput): Promise<void>;
  read(reference: WorkReference, principal: WorkPrincipal): Promise<WorkReadResult>;
}

/** Request-local discovery only. Every page reauthorizes; successful consumption validates fresh owner manifests. */
export async function withWorkCatalogueRead<T>(
  deps: Dependencies,
  ownerUserId: string,
  consume: (reader: WorkListReader) => Promise<T>,
): Promise<T> {
  let catalogue: Promise<RetainedMediaHead[]> | undefined;
  const returned: { principal: WorkPrincipal; scope: WorkPublicationScopeV1 }[] = [];
  let active = true;
  const reader: WorkListReader = {
    async list(principal, after, expectedSnapshot, threadFilter) {
      if (!active || principal.userId !== ownerUserId) throw new MediaOwnerError('access_denied');
      await deps.authorize({ principal, permission: 'read' });
      catalogue ??= readHeads(deps.owner, ownerUserId);
      const visible = await visibleHeads(deps, await catalogue, principal, threadFilter);
      const snapshot = `sha256:${createHash('sha256').update(JSON.stringify(visible)).digest('hex')}`;
      if ((after && !expectedSnapshot) || (expectedSnapshot && expectedSnapshot !== snapshot))
        throw new MediaOwnerError('publication_changed');
      const remaining = visible.filter((item) => !after || item.contentRef.localeCompare(after) > 0);
      const page = remaining.slice(0, 10);
      const items = await Promise.all(page.map((reference) => deps.read(reference, principal)));
      for (const item of items) {
        const scope = item.description.publicationScope;
        if (!isWorkPublicationScope(scope)) throw new MediaOwnerError('access_denied');
        await deps.authorize({ principal, permission: 'read', scope });
        returned.push({ principal, scope });
      }
      return { items, snapshot, ...(remaining.length > page.length ? { nextCursor: page.at(-1)?.contentRef } : {}) };
    },
  };
  try {
    const result = await consume(reader);
    if (catalogue && JSON.stringify(await catalogue) !== JSON.stringify(await readHeads(deps.owner, ownerUserId)))
      throw new MediaOwnerError('publication_changed');
    for (const { principal, scope } of returned) await deps.authorize({ principal, permission: 'read', scope });
    return result;
  } finally {
    active = false;
  }
}

async function visibleHeads(
  deps: Dependencies,
  heads: readonly RetainedMediaHead[],
  principal: WorkPrincipal,
  threadFilter?: string,
) {
  const visible: WorkReference[] = [];
  for (const head of heads) {
    const scope = head.publicationScope;
    if (!isWorkPublicationScope(scope) || (threadFilter && scope.threadId !== threadFilter)) continue;
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

async function readHeads(owner: Dependencies['owner'], ownerUserId: string) {
  const heads: RetainedMediaHead[] = [];
  for await (const head of owner.retainedMediaHeads(ownerUserId)) {
    heads.push(head);
    if (heads.length > 10000) throw new MediaOwnerError('media_unavailable');
  }
  return heads.sort((a, b) => a.contentRef.localeCompare(b.contentRef));
}
