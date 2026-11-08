import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { MemoryCueDocumentWindowRequest, RecallScopeV1 } from '@cat-cafe/shared';
import type { IThreadStore } from '../../../cats/services/stores/ports/ThreadStore.js';
import { deriveProjectCollectionId } from '../../bootstrap-collection-bridge.js';
import type { CollectionManifest } from '../../collection-types.js';
import type { IEvidenceStore } from '../../interfaces.js';
import { KnowledgeResolver } from '../../KnowledgeResolver.js';
import { documentDiscoverySource } from '../../knowledge-document-source.js';
import type { LibraryCatalog } from '../../LibraryCatalog.js';
import { lessonSections } from '../../lesson-sections.js';
import type { PublishedDocumentSnapshot } from '../../PublishedDocumentSource.js';
import type { ContextSourceOmission } from '../context-source-omission.js';
import type { MemoryCueSourceProjection } from '../MemoryCueResolverRegistry.js';
import {
  canonicalProjectDocumentWindow,
  type PublishedProjectCueSource,
  readCanonicalProjectDocument,
} from './canonical-project-document.js';

interface BoundProject {
  manifest: CollectionManifest;
  store: IEvidenceStore;
  digest: string;
  authorized: string[];
  homeBound: boolean;
}
interface Coordinate {
  collectionId: string;
  anchor: string;
  binding: string;
}
const PREFIX = 'project-collection:';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const inactive = new Set(['invalidated', 'superseded', 'retired', 'archived', 'historical', 'stale']);

function encodeCoordinate(coordinate: Coordinate): string {
  return PREFIX + Buffer.from(JSON.stringify(coordinate)).toString('base64url');
}
export function projectCueCoordinate(anchor: string): Coordinate | null {
  if (!anchor.startsWith(PREFIX)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(anchor.slice(PREFIX.length), 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object') return null;
    const x = value as Record<string, unknown>;
    return typeof x.collectionId === 'string' && typeof x.anchor === 'string' && typeof x.binding === 'string'
      ? { collectionId: x.collectionId, anchor: x.anchor, binding: x.binding }
      : null;
  } catch {
    return null;
  }
}

/** Original collection binding + query + original source. Never falls back to the home store. */
export class ContextProjectCueSource {
  constructor(
    private readonly deps: {
      threads: Pick<IThreadStore, 'get'>;
      catalog: Pick<LibraryCatalog, 'get'>;
      stores: ReadonlyMap<string, IEvidenceStore>;
      /** Explicit first-party bootstrap binding, not guessed from a query/path. */
      homeProjectPath: string;
      homeDocsRoot: string;
      publishedSource?: PublishedProjectCueSource;
    },
  ) {}

  private async bind(scope: RecallScopeV1): Promise<BoundProject | null> {
    const thread = await this.deps.threads.get(scope.threadId);
    if (!thread || thread.createdBy !== scope.ownerUserId) return null;
    const project = await realpath(thread.projectPath).catch(() => null);
    const home = await realpath(this.deps.homeProjectPath).catch(() => null);
    if (!project || !home) return null;
    const homeBound = project === home;
    const id = homeBound ? 'project:cat-cafe' : deriveProjectCollectionId(thread.projectPath);
    const manifest = this.deps.catalog.get(id);
    if (!manifest || manifest.kind !== 'project' || (manifest.status && manifest.status !== 'active')) return null;
    const root = await realpath(manifest.root).catch(() => null);
    const expectedRoot = homeBound ? await realpath(this.deps.homeDocsRoot).catch(() => null) : project;
    if (!root || root !== expectedRoot) return null;
    const privateSource = manifest.sensitivity === 'private' || manifest.sensitivity === 'restricted';
    if (privateSource && manifest.ownerUserId !== scope.ownerUserId) return null;
    const store = this.deps.stores.get(id);
    if (!store) return null;
    const digest = sha(
      JSON.stringify([
        id,
        project,
        root,
        manifest.ownerUserId ?? null,
        manifest.sensitivity,
        manifest.status ?? 'active',
        manifest.updatedAt,
      ]),
    );
    return { manifest, store, digest, authorized: privateSource ? [id] : [], homeBound };
  }

  async discover(input: { scope: RecallScopeV1; query: string; signal?: AbortSignal }): Promise<{
    sources: MemoryCueSourceProjection[];
    omission?: ContextSourceOmission;
    omissions?: ContextSourceOmission[];
  }> {
    const omissions = new Set<ContextSourceOmission>();
    const source = await this.discoverySource({ ...input, onOmission: (reason) => omissions.add(reason) });
    if (!source) return { sources: [], omission: 'scope_unavailable' };
    const found = await KnowledgeResolver.discover(input.query, {
      sources: [source],
      limit: 2,
      candidateBudget: 20,
      waveSize: 2,
      signal: input.signal,
      deadlineAt: Date.now() + 1500,
    });
    return {
      sources: found.items,
      omissions: [...omissions],
      omission: found.items.length ? undefined : [...omissions][0],
    };
  }

  /** Native index adapter; binding and canonical reads remain this owner's responsibility. */
  async discoverySource(input: {
    scope: RecallScopeV1;
    query: string;
    signal?: AbortSignal;
    onOmission?(reason: ContextSourceOmission): void;
  }) {
    const bound = await this.bind(input.scope);
    if (!bound) return null;
    let degraded = false;
    let activeSignal = input.signal;
    const native = documentDiscoverySource({
      id: `project:${bound.manifest.id}`,
      store: bound.store,
      options: { scope: 'docs', depth: 'summary', mode: 'hybrid' },
      requireMatchEvidence: input.query,
      onMeta: (meta) => {
        degraded = meta.degraded || (!!meta.effectiveMode && meta.effectiveMode !== 'hybrid');
        if (degraded) input.onOmission?.('degraded');
      },
    });
    const project = async (anchor: string) => {
      activeSignal?.throwIfAborted();
      const current = await this.bind(input.scope);
      if (!current || current.digest !== bound.digest) {
        input.onOmission?.('scope_unavailable');
        return null;
      }
      const published = bound.homeBound ? await this.deps.publishedSource?.snapshot() : undefined;
      const projection = await this.project(bound, anchor, published);
      if ('omission' in projection) {
        input.onOmission?.(projection.omission);
        return null;
      }
      activeSignal?.throwIfAborted();
      return projection.source;
    };
    return {
      id: native.id,
      eligible: native.eligible,
      candidateKey: native.candidateKey,
      read: async (request: Parameters<typeof native.read>[0]) => {
        activeSignal = request.signal ?? input.signal;
        const batch = await native.read(request);
        return degraded ? { candidates: [] } : batch;
      },
      project: (candidate: Parameters<typeof native.project>[0]) => project(candidate.anchor),
      revalidate: async (item: MemoryCueSourceProjection) => {
        const coordinate = projectCueCoordinate(item.anchor);
        const current = coordinate ? await project(coordinate.anchor) : null;
        return current?.revision === item.revision ? current : null;
      },
      key: (item: MemoryCueSourceProjection) => item.anchor,
    };
  }

  private async project(
    bound: BoundProject,
    anchor: string,
    published?: PublishedDocumentSnapshot,
  ): Promise<
    | {
        source: MemoryCueSourceProjection;
        content: string;
        sourcePath: string;
        defaultOffset?: number;
      }
    | { omission: ContextSourceOmission }
  > {
    const item = await bound.store.getByAnchor(anchor);
    if (!item || inactive.has(item.status) || item.supersededBy) return { omission: 'source_unavailable' };
    if (!item.sourceHash || !/^[0-9a-f]{16,64}$/.test(item.sourceHash))
      return { omission: 'index_revision_unverified' };
    const indexed = await bound.store.getIndexedSourceRevision?.(anchor);
    if (!indexed || indexed.sourceHash !== item.sourceHash || !indexed.vectorSourceHash)
      return { omission: 'index_revision_unverified' };
    if (indexed.vectorSourceHash !== indexed.sourceHash) return { omission: 'index_stale' };
    const document = await readCanonicalProjectDocument(bound.manifest.root, item.sourcePath, published);
    if (!document) return { omission: 'source_unavailable' };
    const splitLesson =
      item.kind === 'lesson' && item.sourcePath === 'lessons-learned.md' && /^LL-\d+$/.test(item.anchor);
    const lesson = splitLesson
      ? lessonSections(document.content).find((section) => section.anchor === item.anchor)
      : undefined;
    if (splitLesson && !lesson) return { omission: 'source_unavailable' };
    if (!sha(lesson?.content ?? document.content).startsWith(item.sourceHash)) return { omission: 'index_stale' };
    const coordinate = encodeCoordinate({
      collectionId: bound.manifest.id,
      anchor: item.anchor,
      binding: bound.digest,
    });
    if (coordinate.length > 500) return { omission: 'source_unavailable' };
    return {
      content: document.content,
      sourcePath: document.sourcePath,
      ...(lesson ? { defaultOffset: lesson.start } : {}),
      source: {
        title: 'Current project source',
        summary: 'A current project source can be read.',
        anchor: coordinate,
        revision: document.revision,
        visibility: bound.authorized.length ? 'owner_private' : 'owner_public',
        drillFamily: 'evidence',
      },
    };
  }

  async read(input: {
    scope: RecallScopeV1;
    anchor: string;
    expectedRevision: string;
    window?: MemoryCueDocumentWindowRequest;
  }) {
    const coordinate = projectCueCoordinate(input.anchor);
    const bound = coordinate ? await this.bind(input.scope) : null;
    if (!bound || !coordinate || coordinate.collectionId !== bound.manifest.id || coordinate.binding !== bound.digest) {
      return { status: 'not_available' as const, invalidationReason: 'scope_revoked' as const };
    }
    const published = bound.homeBound ? await this.deps.publishedSource?.snapshot() : undefined;
    const current = await this.project(bound, coordinate.anchor, published);
    if ('omission' in current)
      return {
        status: 'not_available' as const,
        invalidationReason:
          current.omission === 'index_stale' ? ('source_corrected' as const) : ('source_forgotten' as const),
      };
    if (current.source.revision !== input.expectedRevision)
      return { status: 'not_available' as const, invalidationReason: 'source_corrected' as const };
    const finalBinding = await this.bind(input.scope);
    if (!finalBinding || finalBinding.digest !== bound.digest)
      return { status: 'not_available' as const, invalidationReason: 'scope_revoked' as const };
    return {
      status: 'ok' as const,
      payload: {
        anchor: coordinate.anchor,
        collectionId: coordinate.collectionId,
        sourceRevision: current.source.revision,
        sourcePath: current.sourcePath,
        ...canonicalProjectDocumentWindow(
          current.content,
          input.window ?? (current.defaultOffset === undefined ? {} : { offset: current.defaultOffset }),
        ),
      },
    };
  }
}
