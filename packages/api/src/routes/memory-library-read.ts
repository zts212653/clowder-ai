import type { CollectionManifest } from '../domains/memory/collection-types.js';
import type { Marker } from '../domains/memory/interfaces.js';

export function visibleMemoryCollections(
  manifests: readonly CollectionManifest[],
  privateUserId: string | null,
): CollectionManifest[] {
  return manifests.filter(
    (m) =>
      m.sensitivity === 'public' ||
      m.sensitivity === 'internal' ||
      (privateUserId !== null && m.ownerUserId === privateUserId),
  );
}

const PENDING = new Set(['captured', 'normalized', 'needs_review']);
const SETTLED = new Set(['approved', 'materialized', 'indexed', 'rejected']);

export function memoryLibraryFeed(markers: readonly Marker[], manifests: readonly CollectionManifest[]) {
  const allowed = new Set(manifests.map((m) => m.id));
  const visible = markers.filter((marker) => {
    if (marker.sourceCollectionId) return allowed.has(marker.sourceCollectionId);
    return (
      !marker.sourceSensitivity || marker.sourceSensitivity === 'public' || marker.sourceSensitivity === 'internal'
    );
  });
  const rows = visible
    .map((marker) => ({
      id: marker.id,
      content: marker.content.replace(/\b(?:thread_|thread-thread_)[a-z0-9_-]+\b/gi, '来源对话'),
      kind: marker.targetKind ?? 'lesson',
      createdAt: marker.createdAt,
      collectionName: manifests.find((m) => m.id === marker.sourceCollectionId)?.displayName ?? null,
      state: PENDING.has(marker.status)
        ? '待收录'
        : marker.status === 'approved'
          ? '已批准 · 收录结果没有记录'
          : marker.status === 'rejected'
            ? '未收录'
            : '已收录',
      pending: PENDING.has(marker.status),
      settled: SETTLED.has(marker.status),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { pending: rows.filter((row) => row.pending), processed: rows.filter((row) => row.settled) };
}
