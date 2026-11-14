import { evidenceDisplayType } from '../domains/memory/evidence-display-type.js';
import type { CollectionManifest, EvidenceItem } from '../domains/memory/interfaces.js';
import { KnowledgeResolver } from '../domains/memory/KnowledgeResolver.js';
import type { KnowledgeDiscoverySource } from '../domains/memory/knowledge-discovery.js';
import { documentDiscoverySource } from '../domains/memory/knowledge-document-source.js';
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
/** Owner projection and presentation stay here; all candidate work uses the common resolver. */
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
  let partial = false;
  let degraded = false;
  const sources: KnowledgeDiscoverySource<EvidenceItem, MemorySearchGroup['results'][number]>[] = [];
  for (const manifest of visible) {
    const store = opts.stores.get(manifest.id);
    if (!store) {
      partial = true;
      continue;
    }
    const adapter = documentDiscoverySource({
      id: manifest.id,
      store,
      options: { ...execution, scope: 'docs', mode: 'hybrid', depth: query.depth, limit: query.limit + 1 },
      onMeta: (meta) => {
        if (meta.degraded) {
          partial = true;
          degraded = true;
        }
      },
    });
    const observed = new Map<string, EvidenceItem>();
    const project = async (item: EvidenceItem) => {
      checkMemorySearchExecution(execution);
      if (isMemoryIndexPath(item.sourcePath ?? '') || /^(thread|session)$/.test(item.kind)) return null;
      const canonical = await store.getByAnchor(item.anchor);
      if (!canonical || canonical.kind !== item.kind || canonical.sourcePath !== item.sourcePath) {
        partial = true;
        return null;
      }
      const row = await projectDocument(manifest, canonical, manifests, query);
      if (row) observed.set(row.id, { ...canonical });
      return row;
    };
    sources.push({
      id: adapter.id,
      read: adapter.read,
      project,
      key: (row) => row.id,
      tolerateError: true,
      revalidate: async (row) => {
        const currentManifest = visibleMemoryCollections(opts.catalog.list(), privateUserId).find(
          (item) => item.id === manifest.id,
        );
        if (
          !currentManifest ||
          currentManifest.status === 'archived' ||
          currentManifest.status === 'blocked' ||
          currentManifest.root !== manifest.root
        )
          return null;
        const original = observed.get(row.id);
        if (!original) return null;
        const current = await store.getByAnchor(original.anchor);
        if (!current || current.sourceHash !== original.sourceHash || current.updatedAt !== original.updatedAt) {
          partial = true;
          return null;
        }
        return project(current);
      },
    });
  }
  const found = await KnowledgeResolver.discover(query.q, {
    sources,
    limit: query.limit + 1,
    merge: 'source_order',
    ...execution,
  });
  const available = !visible.length || found.sources.some((source) => source.stopReason !== 'error');
  return {
    type: 'documents',
    status: !available
      ? 'unavailable'
      : partial || found.sources.some((source) => source.stopReason === 'error')
        ? 'partial'
        : 'ready',
    results: found.items.slice(0, query.limit),
    hasMore:
      found.items.length > query.limit ||
      found.sources.some((source) => ['limit', 'candidate_budget', 'source_budget'].includes(source.stopReason)),
    degraded,
  };
}
