import { Buffer } from 'node:buffer';
import {
  APPROVAL_PRODUCER_IDS,
  type ApprovalHistoryPage,
  type ApprovalHistoryPageRequest,
  type ApprovalProducerId,
  compareApprovalHistoryId,
  type SettledApprovalHubItem,
} from '@cat-cafe/shared';
import type { SettledHistoryPosition } from '../../utils/settled-history-page.js';
import type { ApprovalProducerRegistry } from './ApprovalProducerRegistry.js';

type Position = { decidedAt: number; producerId: ApprovalProducerId; proposalId: string };
type Cursor = { v: 1; owner: string; query: string; before: Position };
const compareId = compareApprovalHistoryId;
const compare = (a: Position, b: Position) =>
  b.decidedAt - a.decidedAt || compareId(a.producerId, b.producerId) || compareId(a.proposalId, b.proposalId);
const position = (item: SettledApprovalHubItem): Position => ({
  decidedAt: item.decidedAt,
  producerId: item.sourceFeatureId,
  proposalId: item.proposalId,
});
const badQuery = () => Object.assign(new Error('Invalid approval history query or cursor'), { statusCode: 400 });

function parseCursor(value: string | undefined, owner: string, query: string): Position | undefined {
  if (!value) return;
  try {
    if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw badQuery();
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    if (
      parsed.v !== 1 ||
      parsed.owner !== owner ||
      parsed.query !== query ||
      !APPROVAL_PRODUCER_IDS.includes(parsed.before.producerId) ||
      !Number.isSafeInteger(parsed.before.decidedAt) ||
      parsed.before.decidedAt < 0 ||
      typeof parsed.before.proposalId !== 'string' ||
      !parsed.before.proposalId ||
      parsed.before.proposalId.length > 512
    )
      throw badQuery();
    return parsed.before;
  } catch {
    throw badQuery();
  }
}

/** Only source prefixes whose lower frontier is known can contribute to a globally ordered page. */
export async function readApprovalHistoryPage(
  registry: ApprovalProducerRegistry,
  owner: string,
  request: ApprovalHistoryPageRequest,
): Promise<ApprovalHistoryPage> {
  const limit = request.limit ?? 30;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 60 ||
    (request.producer !== undefined && !APPROVAL_PRODUCER_IDS.includes(request.producer)) ||
    (request.resolution !== undefined &&
      !['accepted', 'rejected', 'closed_without_decision'].includes(request.resolution))
  )
    throw badQuery();
  const query = JSON.stringify({ producer: request.producer ?? null, resolution: request.resolution ?? null });
  const before = parseCursor(request.cursor, owner, query);
  const sources = registry
    .manifest()
    .map((item) => item.id)
    .filter((id) => !request.producer || id === request.producer);
  if (request.producer && sources.length !== 1) throw badQuery();
  const results = await Promise.allSettled(
    sources.map(async (id) => {
      const bound: SettledHistoryPosition | undefined = before
        ? {
            decidedAt: before.decidedAt,
            proposalId: id === before.producerId ? before.proposalId : compareId(id, before.producerId) < 0 ? '' : null,
          }
        : undefined;
      const page = await registry.listSettledPageFor(id, owner, { limit: limit + 1, before: bound });
      if (page.hasMore && (!page.frontier || !page.frontier.proposalId))
        throw new Error(`Missing history frontier: ${id}`);
      const frontier = page.frontier?.proposalId
        ? { ...page.frontier, proposalId: page.frontier.proposalId, producerId: id }
        : null;
      for (const item of page.records) {
        const key = position(item);
        if (
          !Number.isSafeInteger(key.decidedAt) ||
          key.decidedAt < 0 ||
          (before && compare(key, before) <= 0) ||
          (frontier && compare(key, frontier) > 0)
        )
          throw new Error(`Invalid canonical history order: ${id}`);
      }
      return { ...page, frontier };
    }),
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  const pages = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  const frontiers = pages.flatMap((page) => (page.hasMore && page.frontier ? [page.frontier] : [])).sort(compare);
  // The newest nonexhausted source frontier is the last globally safe position.
  const safeFrontier = frontiers[0];
  const available = pages
    .flatMap((page) => page.records)
    .filter(
      (item) =>
        (!request.resolution || item.resolution === request.resolution) &&
        (!safeFrontier || compare(position(item), safeFrontier) <= 0),
    )
    .sort((a, b) => compare(position(a), position(b)));
  const keys = available.map((item) => `${item.sourceFeatureId}:${item.proposalId}`);
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate canonical approval history identity');
  const items = available.slice(0, limit);
  const hasMore = available.length > limit || pages.some((page) => page.hasMore);
  const nextBefore = available.length > limit ? position(items.at(-1)!) : safeFrontier;
  if (hasMore && (!nextBefore || (before && compare(nextBefore, before) <= 0)))
    throw new Error('Approval history page made no progress');
  const nextCursor = hasMore
    ? Buffer.from(JSON.stringify({ v: 1, owner, query, before: nextBefore })).toString('base64url')
    : null;
  return {
    items,
    count: items.length,
    identity: { ownerUserId: owner },
    manifest: registry.manifest(),
    page: { limit, nextCursor, hasMore },
    coverage: { state: 'complete', orderVersion: 1, sources },
  };
}
