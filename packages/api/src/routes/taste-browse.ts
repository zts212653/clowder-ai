import {
  type TasteMemoryCorrectionProposalView,
  type TasteMemoryOwnerAction,
  type TasteProposal,
  tasteMemoryOwnerActionSchema,
} from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { TasteMemoryLifecycleService } from '../domains/memory/taste/TasteMemoryLifecycleService.js';
import type { TasteMemoryLifecycleStore } from '../domains/memory/taste/TasteMemoryLifecycleStore.js';
import type { TasteMemoryReadResult } from '../domains/memory/taste/TasteMemoryReader.js';
import type { TasteObservatorySnapshot } from '../domains/memory/taste/TasteObservatoryReader.js';
import { tasteSourceAnchor } from '../domains/memory/taste/taste-memory-identity.js';
import type { TasteRepository } from '../domains/taste/services/TasteRepository.js';
import { resolveDirectLocalAuthorizationUserId, resolveSessionUserId } from '../utils/request-identity.js';
import { authorizeOwnerBrowserAction, ownerMemoryActionHttpStatus } from './owner-memory-browser-auth.js';
import { projectTasteContext, readTasteApproval } from './taste-browse-context.js';
import { projectTasteMemory, projectTasteRecall, tasteMemoryId, visibleTasteMemories } from './taste-browse-model.js';
import { readTasteSource, type TasteSourceReaders } from './taste-browse-source.js';

export interface TasteBrowseOptions extends TasteSourceReaders {
  ownerUserId: string;
  tasteRepository: TasteRepository;
  lifecycleStore?: Pick<TasteMemoryLifecycleStore, 'candidateFor' | 'isReadable' | 'sourcePathForMemoryId'>;
  lifecycleService?: Pick<TasteMemoryLifecycleService, 'executeOwnerAction'>;
  readObservatory: (owner: string, includePrivate: boolean) => Promise<TasteObservatorySnapshot>;
}
type BoundMemory = { Params: { memoryId: string }; Querystring: { revision?: string } };
type ActionMemory = { Params: { memoryId: string }; Body: TasteMemoryOwnerAction };

/** Additive browser-owner reads; no proposal/writer authority is granted here. */
export const tasteBrowseRoutes: FastifyPluginAsync<TasteBrowseOptions> = async (app, opts) => {
  app.addHook('preHandler', async (request, reply) => {
    const user = resolveSessionUserId(request);
    if (!user) return reply.code(401).send({ error: 'Session required' });
    if (user !== opts.ownerUserId) return reply.code(403).send({ error: 'Owner required' });
  });
  app.get('/api/memory/taste', async (request, reply) => {
    try {
      const privateAccess = resolveDirectLocalAuthorizationUserId(request) === opts.ownerUserId;
      const memories = await visibleTasteMemories(
        opts.tasteRepository,
        opts.ownerUserId,
        privateAccess,
        opts.lifecycleStore,
      );
      let stats: TasteObservatorySnapshot | null = null;
      try {
        stats = await opts.readObservatory(opts.ownerUserId, privateAccess);
      } catch {
        /* Independent projection stays partial. */
      }
      const byPath = new Map(stats?.entries.map((entry) => [entry.sourcePath, entry]));
      const titles = new Map<string, Promise<{ title: string | null; threadId?: string }>>();
      return {
        readStatus: stats ? 'ready' : 'partial',
        entries: await Promise.all(
          memories.map(async (memory) => {
            const corrections = await readTasteCorrections(memory.sourcePath, opts.ownerUserId, opts);
            return {
              ...projectTasteMemory(memory, null, {
                takeawayCandidate:
                  opts.lifecycleStore?.candidateFor(opts.ownerUserId, memory.sourcePath, memory.revision) ?? null,
                pendingCorrectionCount: corrections.length,
              }),
              approval: await readTasteApproval(memory, opts.ownerUserId, opts),
              recall: await projectTasteContext(
                projectTasteRecall(byPath.get(memory.sourcePath)),
                opts.ownerUserId,
                opts,
                titles,
              ),
            };
          }),
        ),
        coverage: stats ? { unverified: stats.coverage.totalUnverified } : null,
        dimensionHints: stats?.dimensionHints ?? null,
      };
    } catch {
      return reply.code(503).send({ error: 'Taste source unavailable' });
    }
  });
  for (const source of [false, true]) {
    app.get<BoundMemory>(`/api/memory/taste/:memoryId${source ? '/source' : ''}`, (request, reply) =>
      serveBoundTasteMemory(request, reply, opts, source),
    );
  }
  app.post<ActionMemory>('/api/memory/taste/:memoryId/actions', (request, reply) =>
    serveTasteOwnerAction(request, reply, opts),
  );
};

async function serveBoundTasteMemory(
  request: FastifyRequest<BoundMemory>,
  reply: FastifyReply,
  opts: TasteBrowseOptions,
  source: boolean,
) {
  try {
    const memory = await resolveBoundTasteMemory(request, reply, opts);
    if (!memory) return;
    if (source) return await readTasteSource(memory, opts.ownerUserId, opts);
    const corrections = await readTasteCorrections(memory.sourcePath, opts.ownerUserId, opts);
    return {
      ...projectTasteMemory(memory, null, {
        takeawayCandidate:
          opts.lifecycleStore?.candidateFor(opts.ownerUserId, memory.sourcePath, memory.revision) ?? null,
        pendingCorrectionCount: corrections.length,
        correctionProposals: corrections,
      }),
      approval: await readTasteApproval(memory, opts.ownerUserId, opts),
    };
  } catch {
    return reply.code(503).send({ error: 'Taste source unavailable' });
  }
}

async function resolveBoundTasteMemory(
  request: FastifyRequest<BoundMemory>,
  reply: FastifyReply,
  opts: TasteBrowseOptions,
): Promise<TasteMemoryReadResult | null> {
  if (!/^taste-[0-9a-f]{24}$/.test(request.params.memoryId)) {
    reply.code(404).send({ error: 'Unavailable' });
    return null;
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(request.query.revision ?? '')) {
    reply.code(400).send({ error: 'Revision required' });
    return null;
  }
  const memories = await visibleTasteMemories(
    opts.tasteRepository,
    opts.ownerUserId,
    resolveDirectLocalAuthorizationUserId(request) === opts.ownerUserId,
    opts.lifecycleStore,
  );
  const memory = memories.find((item) => tasteMemoryId(item.sourcePath) === request.params.memoryId);
  if (!memory) {
    reply.code(404).send({ error: 'Unavailable' });
    return null;
  }
  if (memory.revision !== request.query.revision) {
    reply.code(409).send({ error: 'Revision changed' });
    return null;
  }
  return memory;
}

async function serveTasteOwnerAction(
  request: FastifyRequest<ActionMemory>,
  reply: FastifyReply,
  opts: TasteBrowseOptions,
) {
  if (!authorizeOwnerBrowserAction(request)) return reply.code(403).send({ error: 'invalid_action' });
  if (!opts.lifecycleStore || !opts.lifecycleService) {
    return reply.code(503).send({ error: 'mutation_unavailable' });
  }
  const body = tasteMemoryOwnerActionSchema.safeParse(request.body);
  if (!body.success) return reply.code(400).send({ error: 'invalid_request', details: body.error.issues });
  try {
    const sourcePath = await resolveTasteActionSourcePath(request, opts, opts.lifecycleStore);
    if (!sourcePath) return reply.code(404).send({ error: 'not_available' });
    const result = await opts.lifecycleService.executeOwnerAction(
      opts.ownerUserId,
      request.params.memoryId,
      sourcePath,
      body.data,
    );
    return 'error' in result ? reply.code(ownerMemoryActionHttpStatus(result.error)).send(result) : result;
  } catch (error) {
    request.log.warn({ err: error }, '[F321] Owner Taste mutation unavailable');
    return reply.code(503).send({ error: 'mutation_unavailable' });
  }
}

async function resolveTasteActionSourcePath(
  request: FastifyRequest<ActionMemory>,
  opts: TasteBrowseOptions,
  lifecycleStore: NonNullable<TasteBrowseOptions['lifecycleStore']>,
): Promise<string | null> {
  const known = lifecycleStore.sourcePathForMemoryId(opts.ownerUserId, request.params.memoryId);
  if (known) return known;
  const memories = await visibleTasteMemories(
    opts.tasteRepository,
    opts.ownerUserId,
    resolveDirectLocalAuthorizationUserId(request) === opts.ownerUserId,
    lifecycleStore,
  );
  return memories.find((memory) => tasteMemoryId(memory.sourcePath) === request.params.memoryId)?.sourcePath ?? null;
}

async function readTasteCorrections(
  sourcePath: string,
  ownerUserId: string,
  readers: TasteSourceReaders,
): Promise<TasteMemoryCorrectionProposalView[]> {
  if (!readers.proposalStore.listCorrectionsBySource) return [];
  const proposals = await readers.proposalStore.listCorrectionsBySource(
    ownerUserId,
    tasteSourceAnchor(sourcePath),
    100,
  );
  return proposals.flatMap((proposal) => {
    const view = toCorrectionView(proposal);
    return view ? [view] : [];
  });
}

function toCorrectionView(proposal: TasteProposal): TasteMemoryCorrectionProposalView | null {
  const target = proposal.correctionTarget;
  if (!target) return null;
  return {
    proposalId: proposal.id,
    status: proposal.status,
    expectedRevision: target.expectedRevision,
    reason: target.reason,
    suggestedPatch: structuredClone(target.suggestedPatch),
    sourceCatId: proposal.catId,
    sourceThreadId: proposal.threadId,
    createdAt: proposal.createdAt,
    ...(proposal.rejectionReason ? { rejectionReason: proposal.rejectionReason } : {}),
  };
}
