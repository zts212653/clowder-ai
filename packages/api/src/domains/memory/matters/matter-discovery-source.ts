import type { MatterCatalog, MatterPage } from '@cat-cafe/shared';
import { KnowledgeResolver } from '../KnowledgeResolver.js';
import type { KnowledgeDiscoverySource } from '../knowledge-discovery.js';
import {
  type MatterCatalogContext,
  type MatterCatalogKey,
  type MatterCatalogProgress,
  matterCatalogCursor,
  readMatterDiscoveryCursor,
} from './matter-catalog-cursor.js';
import { type MatterDiscoveryIndex, type MatterDiscoveryRow } from './matter-discovery-index.js';
import { type MatterActor, matterDigest } from './matter-source.js';

export interface MatterDiscoveryCandidate {
  row: MatterDiscoveryRow;
  related: boolean;
  progressAfter: MatterCatalogProgress;
}
export interface AdmittedMatterCandidate {
  item: MatterCatalog['items'][number];
  key: MatterCatalogKey;
  candidate: MatterDiscoveryCandidate;
}

/** Invocation-local owner handoff; page bodies are never properties of admitted candidates. */
export interface MatterDiscoverySource
  extends KnowledgeDiscoverySource<MatterDiscoveryCandidate, AdmittedMatterCandidate> {
  admittedPage(candidate: AdmittedMatterCandidate, reader: MatterActor): MatterPage | null;
}

/** Index selects coordinates; the original project() remains the only page/permission owner. */
export function bindMatterDiscoverySource(
  index: MatterDiscoveryIndex,
  project: (actor: MatterActor, matterId: string) => Promise<MatterPage | null>,
  actor: MatterActor,
  options: MatterCatalogContext & { cursor?: string; limit?: number; signal?: AbortSignal },
) {
  const readerScope = (reader: MatterActor) =>
    matterDigest([
      reader.userId,
      reader.viewer.type === 'user' ? 'owner' : `cat:${reader.viewer.catId}`,
      reader.publicReply === true,
    ]);
  const boundReader = readerScope(actor);
  const management = options.management === true && actor.viewer.type === 'user';
  const state = readMatterDiscoveryCursor(actor, options, options.cursor);
  const limit = Math.max(1, Math.min(options.limit ?? 12, 30));
  const preference = !management && Boolean(options.threadId);
  const initial: MatterCatalogProgress = state.progress ?? {
    related: preference && state.after?.related !== false,
    offset: 0,
  };
  let pages = new Map<string, MatterPage | null>();
  let admittedPages = new WeakMap<AdmittedMatterCandidate, MatterPage>();
  let activeSignal = options.signal;
  let activeQuery = options.query;
  let progressAfter = initial;
  const admit = async (candidate: MatterDiscoveryCandidate, fresh = false): Promise<AdmittedMatterCandidate | null> => {
    const signal = activeSignal;
    const cache = pages;
    const handoff = admittedPages;
    const { row } = candidate;
    if (!fresh) progressAfter = candidate.progressAfter;
    signal?.throwIfAborted();
    if (!index.current(actor.userId, row)) return null;
    if (fresh || !cache.has(row.matterId)) cache.set(row.matterId, await project({ ...actor, signal }, row.matterId));
    signal?.throwIfAborted();
    if (cache !== pages) return null;
    if (!index.current(actor.userId, row)) return null;
    const page = cache.get(row.matterId)!;
    const key = { related: false, updatedAt: row.updatedAt, matterId: row.matterId };
    if (!page)
      return management && !activeQuery
        ? {
            item: { matterId: row.matterId, revision: row.revision, status: row.status, unavailable: true },
            key,
            candidate,
          }
        : null;
    if (page.matter.revision !== row.revision || page.matter.updatedAt !== row.updatedAt) return null;
    const related = Boolean(
      preference &&
        page.entries.some(
          (entry) =>
            entry.status === 'active' && entry.sourceStatus === 'current' && entry.source.threadId === options.threadId,
        ),
    );
    if (related !== candidate.related) return null;
    const admitted: AdmittedMatterCandidate = {
      item: {
        ...page.matter,
        entryCount: page.entries.filter((entry) => entry.status === 'active').length,
        ...(options.threadId ? { hasThreadSource: related } : {}),
        ...(page.summaryStatus ? { summaryStatus: page.summaryStatus } : {}),
      },
      key: { ...key, related },
      candidate,
    };
    handoff.set(admitted, page);
    return admitted;
  };
  const source: MatterDiscoverySource = {
    id: 'matters',
    read: async ({ query, cursor, limit: batchLimit, signal }) => {
      if ((signal ?? options.signal) !== activeSignal) {
        pages = new Map();
        admittedPages = new WeakMap();
      }
      activeSignal = signal ?? options.signal;
      activeQuery = options.query ?? query;
      const progress: MatterCatalogProgress = cursor ? JSON.parse(cursor) : initial;
      const rows = index.candidates(actor.userId, {
        query: options.query ?? query,
        threadId: options.threadId,
        management,
        relatedOnly: progress.related,
        after: state.after,
        offset: progress.offset,
        limit: batchLimit,
      });
      const next =
        rows.length === batchLimit
          ? { ...progress, offset: progress.offset + rows.length }
          : progress.related
            ? { related: false, offset: 0 }
            : undefined;
      return {
        candidates: rows.map((row, position) => ({
          row,
          related: progress.related,
          progressAfter: { related: progress.related, offset: progress.offset + position + 1 },
        })),
        ...(next ? { nextCursor: JSON.stringify(next) } : {}),
      };
    },
    project: (candidate) => admit(candidate),
    key: ({ key }) => key.matterId,
    revalidate: (row) => admit(row.candidate, true),
    admittedPage: (row, reader) => {
      activeSignal?.throwIfAborted();
      if (!reader || readerScope(reader) !== boundReader) return null;
      return admittedPages.get(row) ?? null;
    },
  };
  return { source, state, limit, progressAfter: () => progressAfter };
}

export async function discoverMatterCatalog(
  index: MatterDiscoveryIndex,
  project: (actor: MatterActor, matterId: string) => Promise<MatterPage | null>,
  actor: MatterActor,
  options: MatterCatalogContext & { cursor?: string; limit?: number; signal?: AbortSignal },
): Promise<MatterCatalog> {
  const binding = bindMatterDiscoverySource(index, project, actor, options);
  const { state, limit } = binding;
  const discovery = await KnowledgeResolver.discover(options.query ?? '', {
    limit: limit + 1,
    waveSize: 1,
    candidateBudget: 1000,
    signal: options.signal,
    sources: [binding.source],
  });
  const admitted = discovery.items;
  options.signal?.throwIfAborted();
  const source = discovery.sources[0]!;
  const next =
    admitted.length > limit
      ? matterCatalogCursor(actor, options, admitted[limit - 1]!.key)
      : source.stopReason === 'limit' || source.stopReason === 'candidate_budget'
        ? matterCatalogCursor(actor, options, state.after, binding.progressAfter())
        : undefined;
  return { items: admitted.slice(0, limit).map(({ item }) => item), ...(next ? { nextCursor: next } : {}) };
}
