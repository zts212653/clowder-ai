import { evidenceDisplayType } from '../domains/memory/evidence-display-type.js';
import type { CollectionManifest, EvidenceItem, IEvidenceStore } from '../domains/memory/interfaces.js';
import { readWorkspaceFilePreview } from '../domains/workspace/workspace-file-read.js';
import { visibleMemoryCollections } from './memory-library-read.js';
import { memoryDocumentPath } from './memory-search-document-source.js';
import {
  checkMemorySearchExecution,
  isMemoryIndexPath,
  type MemorySearchGroup,
  type MemorySearchOptions,
  type MemorySearchQuery,
  type SearchExecution,
} from './memory-search-types.js';

type CollectionResult = {
  rows: MemorySearchGroup['results'];
  available: boolean;
  partial: boolean;
  hasMore: boolean;
  degraded: boolean;
};
const unavailable = (): CollectionResult => ({
  rows: [],
  available: false,
  partial: true,
  hasMore: false,
  degraded: false,
});

async function sourceSnippet(item: EvidenceItem, path: string | null, query: MemorySearchQuery) {
  if (query.depth !== 'raw' || !path) return item.summary ?? '';
  const preview = await readWorkspaceFilePreview(path, { maxBytes: 32_768 });
  if (preview.binary) return item.summary ?? '';
  const at = preview.content.toLocaleLowerCase().indexOf(query.q.toLocaleLowerCase());
  const start = Math.max(0, at - 80);
  return preview.content.slice(start, start + 480);
}
async function projectDocument(
  manifest: CollectionManifest,
  item: EvidenceItem,
  manifests: CollectionManifest[],
  query: MemorySearchQuery,
) {
  let path: string | null = null;
  try {
    path = await memoryDocumentPath(manifest, item, manifests);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
  }
  return {
    id: `${manifest.id}:${item.anchor}`,
    title: item.title.slice(0, 180),
    snippet: (await sourceSnippet(item, path, query)).slice(0, 480),
    displayType: evidenceDisplayType(item),
    authority: item.authority ?? null,
    updatedAt: item.updatedAt ?? null,
    destination: path ? { kind: 'document' as const, collection: manifest.id, anchor: item.anchor } : null,
    graph:
      path && ['public', 'internal'].includes(manifest.sensitivity)
        ? { collection: manifest.id, anchor: item.anchor }
        : null,
  };
}
async function projectItems(
  store: IEvidenceStore,
  items: EvidenceItem[],
  manifest: CollectionManifest,
  manifests: CollectionManifest[],
  query: MemorySearchQuery,
  execution: SearchExecution,
) {
  const rows: MemorySearchGroup['results'] = [];
  let partial = false;
  for (const item of items) {
    checkMemorySearchExecution(execution);
    if (!item || isMemoryIndexPath(item.sourcePath ?? '') || /^(thread|session)$/.test(item.kind)) continue;
    const canonical = await store.getByAnchor(item.anchor);
    if (!canonical || canonical.kind !== item.kind || canonical.sourcePath !== item.sourcePath) {
      partial = true;
      continue;
    }
    const row = await projectDocument(manifest, canonical, manifests, query);
    if (row) rows.push(row);
  }
  return { rows, partial };
}
async function searchCollection(
  manifest: CollectionManifest,
  manifests: CollectionManifest[],
  opts: MemorySearchOptions,
  query: MemorySearchQuery,
  execution: SearchExecution,
): Promise<CollectionResult> {
  try {
    const store = opts.stores.get(manifest.id);
    if (!store) return unavailable();
    const options = {
      ...execution,
      scope: 'docs' as const,
      mode: 'hybrid' as const,
      depth: query.depth,
      limit: query.limit + 1,
    };
    const search = store.searchWithMeta
      ? await store.searchWithMeta(query.q, options)
      : { items: await store.search(query.q, options), meta: { degraded: false } };
    if (!Array.isArray(search.items)) return unavailable();
    const projected = await projectItems(store, search.items, manifest, manifests, query, execution);
    return {
      ...projected,
      available: true,
      partial: projected.partial || search.meta.degraded,
      hasMore: search.items.length > query.limit,
      degraded: search.meta.degraded,
    };
  } catch {
    return unavailable();
  }
}
/** Bounded fan-out; native per-collection relevance is preserved in catalog order. */
export async function searchMemoryDocuments(
  opts: MemorySearchOptions,
  privateUserId: string | null,
  query: MemorySearchQuery,
  execution: SearchExecution,
): Promise<MemorySearchGroup> {
  const manifests = opts.catalog.list();
  const visible = visibleMemoryCollections(manifests, privateUserId).filter(
    (m) => m.status !== 'archived' && m.status !== 'blocked',
  );
  const collections: CollectionResult[] = [];
  for (let offset = 0; offset < visible.length; offset += 4) {
    checkMemorySearchExecution(execution);
    collections.push(
      ...(await Promise.all(
        visible
          .slice(offset, offset + 4)
          .map((manifest) => searchCollection(manifest, manifests, opts, query, execution)),
      )),
    );
  }
  const rows = collections.flatMap((c) => c.rows);
  const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
  const available = !visible.length || collections.some((c) => c.available);
  return {
    type: 'documents',
    status: !available ? 'unavailable' : collections.some((c) => c.partial) ? 'partial' : 'ready',
    results: unique.slice(0, query.limit),
    hasMore: collections.some((c) => c.hasMore) || unique.length > query.limit,
    degraded: collections.some((c) => c.degraded),
  };
}
