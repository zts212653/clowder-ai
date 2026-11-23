import type { MatterCatalog, MatterCatalogItem } from '@cat-cafe/shared';
import type { MatterMemoryService } from './MatterMemoryService.js';
import { matterCatalogCursor } from './matter-catalog-cursor.js';
import type { MatterDiscoveryRow } from './matter-discovery-index.js';
import type { AdmittedMatterCandidate } from './matter-discovery-source.js';
import type { MatterActor } from './matter-source.js';

export type OpeningDirectoryService = Pick<MatterMemoryService, 'catalog'> &
  Partial<Pick<MatterMemoryService, 'discoverySource'>>;
interface Snapshot {
  savedAt: number;
  rows: { row: MatterDiscoveryRow; related: boolean }[];
  nextCursor?: string;
}
const scopesPerService = 128;
// Only coordinates survive invocations; neither rendered text nor an authorized page is cached.
const snapshots = new WeakMap<OpeningDirectoryService, Map<string, Snapshot>>();
const scope = (actor: MatterActor, threadId?: string) => JSON.stringify([actor.userId, actor.viewer, threadId ?? null]);

export function rememberOpeningSnapshot(
  service: OpeningDirectoryService,
  actor: MatterActor,
  threadId: string | undefined,
  catalog: MatterCatalog,
): void {
  if (!service.discoverySource) return;
  let entries = snapshots.get(service);
  if (!entries) {
    entries = new Map();
    snapshots.set(service, entries);
  }
  const key = scope(actor, threadId);
  entries.delete(key);
  entries.set(key, {
    savedAt: Date.now(),
    rows: catalog.items
      .filter((item): item is MatterCatalogItem => !('unavailable' in item))
      .slice(0, 12)
      .map(({ matterId, revision, status, updatedAt, hasThreadSource }) => ({
        row: { matterId, revision, status, updatedAt },
        related: hasThreadSource === true,
      })),
    ...(catalog.nextCursor ? { nextCursor: catalog.nextCursor } : {}),
  });
  const oldest = entries.keys().next().value;
  if (entries.size > scopesPerService && oldest !== undefined) entries.delete(oldest);
}

export async function restoreOpeningSnapshot(
  service: OpeningDirectoryService,
  actor: MatterActor,
  threadId: string | undefined,
  signal: AbortSignal,
): Promise<{ catalog: MatterCatalog; savedAt: number; discardedCount: number } | undefined> {
  const snapshot = snapshots.get(service)?.get(scope(actor, threadId));
  if (!snapshot || !service.discoverySource) return;
  // A new binding cannot reuse the previous invocation's page/permission handoff.
  const source = service.discoverySource(actor, { threadId, signal });
  const revalidate = source.revalidate;
  if (!revalidate) return;
  const admitted: AdmittedMatterCandidate[] = [];
  for (const candidate of snapshot.rows) {
    signal.throwIfAborted();
    const item = await source.project({ ...candidate, progressAfter: { related: false, offset: 0 } });
    if (item) admitted.push(item);
  }
  const items: MatterCatalogItem[] = [];
  // Preserve the catalog's final fresh revalidation, including revocation during later reads.
  for (const candidate of admitted) {
    signal.throwIfAborted();
    const fresh = await revalidate(candidate);
    if (fresh && !('unavailable' in fresh.item)) items.push(fresh.item);
  }
  signal.throwIfAborted();
  if (snapshot.rows.length > 0 && items.length === 0) return;
  const last = items.at(-1);
  const nextCursor =
    snapshot.nextCursor && last
      ? matterCatalogCursor(
          actor,
          { threadId },
          {
            matterId: last.matterId,
            updatedAt: last.updatedAt,
            related: last.hasThreadSource === true,
          },
        )
      : snapshot.nextCursor;
  return {
    catalog: {
      items,
      ...(nextCursor ? { nextCursor } : {}),
    },
    savedAt: snapshot.savedAt,
    discardedCount: snapshot.rows.length - items.length,
  };
}
