import { resolve } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import {
  type GraphQueryResolution,
  GraphQueryResolver,
  type GraphQueryResolverCatalog,
  type GraphQueryResolverStore,
} from '../domains/memory/GraphQueryResolver.js';
import type {
  EvidenceDrillDown,
  IEvidenceStore,
  IKnowledgeResolver,
  SearchOptions,
} from '../domains/memory/interfaces.js';
import { PerspectivePlanLoader } from '../domains/memory/PerspectivePlanLoader.js';
import { PerspectiveRunner, type PerspectiveRunnerDeps } from '../domains/memory/PerspectiveRunner.js';
import type {
  LoadedPerspectivePlan,
  PerspectiveAnchorCandidate,
  PerspectiveOpenedAnchor,
} from '../domains/memory/perspective-types.js';

export interface PerspectiveRoutesOptions {
  repoRoot?: string;
  evidenceStore?: IEvidenceStore;
  knowledgeResolver?: IKnowledgeResolver;
  graphCatalog?: GraphQueryResolverCatalog;
  graphStores?: Map<string, GraphQueryResolverStore>;
  searchEvidence?: PerspectiveRunnerDeps['searchEvidence'];
  openAnchor?: PerspectiveRunnerDeps['openAnchor'];
  resolveGraph?: PerspectiveRunnerDeps['resolveGraph'];
  now?: () => Date;
  randomId?: () => string;
}

const SUPPORTED_TYPED_READERS = new Set([
  'cat_cafe_get_thread_context',
  'cat_cafe_read_session_digest',
  'cat_cafe_read_session_events',
  'cat_cafe_read_invocation_detail',
  'cat_cafe_read_file_slice',
  'cat_cafe_graph_resolve',
]);
const COLLECTION_URI_PREFIX = 'cat-cafe://collection/';
const LOCAL_PROJECT_COLLECTION_ID = 'project:cat-cafe';

export const perspectiveRoutes: FastifyPluginAsync<PerspectiveRoutesOptions> = async (app, opts) => {
  app.get<{
    Params: { featureId: string; slug: string };
    Querystring: { actorCatId?: string };
  }>('/api/perspectives/:featureId/:slug/run', async (request, reply) => {
    const planId = `${request.params.featureId}/${request.params.slug}`;
    const loader = new PerspectivePlanLoader({ repoRoot: resolve(opts.repoRoot ?? process.cwd()) });
    let loaded: LoadedPerspectivePlan;
    try {
      loaded = await loader.loadById(planId);
    } catch (error) {
      if (isNotFoundError(error)) {
        return reply.code(404).send({ error: `Perspective plan not found: ${planId}` });
      }
      return reply.code(400).send({ error: errorMessage(error) });
    }

    const resolveGraph = opts.resolveGraph ?? buildResolveGraph(opts);
    const runner = new PerspectiveRunner({
      searchEvidence: opts.searchEvidence ?? buildSearchEvidence(opts),
      openAnchor: opts.openAnchor ?? defaultOpenAnchor,
      ...(resolveGraph ? { resolveGraph } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.randomId ? { randomId: opts.randomId } : {}),
    });

    const run = await runner.run(loaded.plan, {
      actorCatId: request.query.actorCatId ?? 'unknown',
    });
    return reply.send(run);
  });
};

function buildSearchEvidence(opts: PerspectiveRoutesOptions): PerspectiveRunnerDeps['searchEvidence'] {
  return async (query: string, searchOptions: SearchOptions) => {
    if (opts.knowledgeResolver) {
      const result = await opts.knowledgeResolver.resolve(query, searchOptions);
      return {
        items: result.results,
        meta: result.meta ?? { degraded: false },
      };
    }
    if (opts.evidenceStore?.searchWithMeta) {
      return opts.evidenceStore.searchWithMeta(query, searchOptions);
    }
    if (opts.evidenceStore) {
      return {
        items: await opts.evidenceStore.search(query, searchOptions),
        meta: { degraded: false },
      };
    }
    throw new Error('Perspective routes require searchEvidence, knowledgeResolver, or evidenceStore');
  };
}

type PerspectiveGraphResolveResult = Awaited<ReturnType<NonNullable<PerspectiveRunnerDeps['resolveGraph']>>>;

function buildResolveGraph(opts: PerspectiveRoutesOptions): PerspectiveRunnerDeps['resolveGraph'] | undefined {
  if (!opts.graphCatalog || !opts.graphStores) return undefined;
  const resolver = new GraphQueryResolver(opts.graphCatalog, opts.graphStores);
  return async (anchor: string) => mapGraphResolution(await resolver.resolve(anchor, { depth: 1 }));
}

function mapGraphResolution(result: GraphQueryResolution): PerspectiveGraphResolveResult {
  if (result.status === 'graph') {
    return {
      status: 'graph',
      anchor: result.resolvedAnchor,
      drillDown: drillDownFromGraphAnchor(result.resolvedAnchor, result.resolvedSource, result.resolvedCollectionId),
    };
  }
  if (result.status === 'candidates') {
    return {
      status: 'candidates',
      candidates: result.candidates.map((candidate) => ({
        anchor: candidate.anchor,
        title: candidate.title,
        drillDown: drillDownFromGraphAnchor(candidate.anchor, candidate.source, candidate.collectionId),
      })),
    };
  }
  return { status: 'no_match' };
}

function drillDownFromGraphAnchor(anchor: string, sourcePath?: string, collectionId?: string): EvidenceDrillDown {
  const filePath = sourcePath ? graphSourcePathForDrillDown(sourcePath, collectionId) : sourcePathFromAnchor(anchor);
  if (filePath) {
    return {
      tool: 'cat_cafe_read_file_slice',
      params: { path: filePath, startLine: '1', endLine: '120' },
      hint: `打开文件切片：read_file_slice(path="${filePath}", startLine=1, endLine=120)`,
    };
  }
  return {
    tool: 'cat_cafe_graph_resolve',
    params: { query: anchor, depth: '1' },
    hint: `查看图谱节点：graph_resolve(query="${anchor}", depth=1)`,
  };
}

function graphSourcePathForDrillDown(sourcePath: string, collectionId?: string): string {
  if (!collectionId || collectionId === LOCAL_PROJECT_COLLECTION_ID || sourcePath.startsWith(COLLECTION_URI_PREFIX)) {
    return sourcePath;
  }
  const encodedPath = sourcePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  return `${COLLECTION_URI_PREFIX}${encodeURIComponent(collectionId)}/${encodedPath}`;
}

function sourcePathFromAnchor(anchor: string): string | undefined {
  if (anchor.startsWith('docs/') && anchor.endsWith('.md')) return anchor;
  if (anchor.startsWith('cat-cafe://collection/')) return anchor;
  return undefined;
}

function defaultOpenAnchor(candidate: PerspectiveAnchorCandidate): Promise<PerspectiveOpenedAnchor> {
  const drillDown = candidate.drillDown;
  if (!drillDown) {
    throw new Error(`Unsupported anchor type: ${candidate.anchor} has no drillDown hint`);
  }
  if (!SUPPORTED_TYPED_READERS.has(drillDown.tool)) {
    throw new Error(`Unsupported typed reader: ${drillDown.tool}`);
  }
  return Promise.resolve({
    anchor: candidate.anchor,
    status: 'route_identified',
    tool: drillDown.tool,
    content: drillDown.hint,
  });
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
