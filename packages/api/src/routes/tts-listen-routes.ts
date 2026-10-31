import { stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ListenDocumentState } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DocumentCacheRunManager } from '../domains/cats/services/tts/DocumentCacheRunManager.js';
import type {
  DocumentListenRepository,
  ListenDocumentKey,
} from '../domains/cats/services/tts/DocumentListenRepository.js';
import type { ListenAssetService } from '../domains/cats/services/tts/ListenAssetService.js';
import { resolveStrictUserId, resolveUserId } from '../utils/request-identity.js';

const AUDIO_ASSET_ID_RE = /^[0-9a-f]{64}\.(wav|mp3)$/;
const documentKeySchema = z.object({
  projectPath: z.string().min(1).max(4096),
  relativePath: z.string().min(1).max(4096),
});
const documentStateSchema = z.object({
  identity: documentKeySchema.extend({ contentDigest: z.string().min(1).max(256) }),
  sentences: z
    .array(z.object({ anchor: z.string().min(1).max(256), assetId: z.string().regex(AUDIO_ASSET_ID_RE).optional() }))
    .max(100000),
  position: z.object({ anchor: z.string().min(1).max(256).nullable(), offsetSeconds: z.number().min(0) }),
  playbackRate: z.union([z.literal(0.75), z.literal(1), z.literal(1.25), z.literal(1.5), z.literal(2)]),
  retention: z.enum(['7d', '30d', 'forever']),
  updatedAt: z.number().int().nonnegative(),
});
const synthesisSchema = z.object({
  catId: z.string().min(1).max(128).optional(),
  voice: z.string().min(1).max(512).optional(),
  langCode: z.string().min(1).max(64).optional(),
  speed: z.number().min(0.5).max(2).optional(),
});
const documentWriteSchema = documentStateSchema.extend({ synthesis: synthesisSchema.optional() });
const assetLinkSchema = documentKeySchema
  .extend({
    anchor: z.string().min(1).max(256),
    assetId: z.string().regex(AUDIO_ASSET_ID_RE),
    contentDigest: z.string().min(1).max(256).optional(),
    synthesisFingerprint: z.string().min(1).max(256).optional(),
  })
  .refine(
    ({ contentDigest, synthesisFingerprint }) => Boolean(contentDigest) === Boolean(synthesisFingerprint),
    'contentDigest and synthesisFingerprint must be supplied together',
  );
const cacheRunSchema = z.object({
  identity: documentKeySchema.extend({ contentDigest: z.string().min(1).max(256) }),
  sentences: z
    .array(z.object({ anchor: z.string().min(1).max(256), text: z.string().min(1).max(20000) }))
    .min(1)
    .max(100000),
  synthesis: synthesisSchema.optional(),
  startAnchor: z.string().min(1).max(256).optional(),
});
const cacheCancelSchema = documentKeySchema.extend({
  contentDigest: z.string().min(1).max(256),
  synthesisFingerprint: z.string().min(1).max(256),
});

interface TtsListenRouteOptions {
  cacheDir: string;
  repository: DocumentListenRepository;
  assets: ListenAssetService;
  cacheRuns: DocumentCacheRunManager;
}

function documentKey(userId: string, input: z.infer<typeof documentKeySchema>): ListenDocumentKey {
  return { userId, projectPath: input.projectPath, relativePath: input.relativePath };
}

function requireReadIdentity(request: Parameters<typeof resolveUserId>[0]): string | null {
  return resolveUserId(request);
}

function requireWriteIdentity(request: Parameters<typeof resolveStrictUserId>[0]): string | null {
  return resolveStrictUserId(request);
}

async function deleteOrphanedAssets(
  cacheDir: string,
  repository: DocumentListenRepository,
  orphaned: string[],
): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;
  for (const assetId of orphaned) {
    if (!AUDIO_ASSET_ID_RE.test(assetId)) continue;
    try {
      await unlink(path.join(cacheDir, assetId));
      deleted++;
      repository.forgetAsset(assetId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') repository.forgetAsset(assetId);
      else failed++;
    }
  }
  return { deleted, failed };
}

async function reconcileDocumentCache(
  cacheDir: string,
  repository: DocumentListenRepository,
  state: ListenDocumentState,
) {
  const assetIds = [...new Set(state.sentences.flatMap(({ assetId }) => (assetId ? [assetId] : [])))];
  const availableSizes = new Map<string, number>();
  for (const assetId of assetIds) {
    if (!AUDIO_ASSET_ID_RE.test(assetId)) continue;
    try {
      const fileStat = await stat(path.join(cacheDir, assetId));
      if (fileStat.isFile()) availableSizes.set(assetId, fileStat.size);
      else repository.forgetAsset(assetId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') repository.forgetAsset(assetId);
    }
  }
  const sentences = state.sentences.map(({ anchor, assetId }) => ({
    anchor,
    ...(assetId && availableSizes.has(assetId) ? { assetId } : {}),
  }));
  return {
    state: { ...state, sentences },
    cache: {
      cachedSentences: sentences.filter(({ assetId }) => assetId).length,
      totalSentences: sentences.length,
      totalBytes: [...availableSizes.values()].reduce((total, size) => total + size, 0),
    },
  };
}

type CacheStartInput = z.infer<typeof cacheRunSchema>;

type CacheStartOutcome =
  | { error: { statusCode: 404 | 409; message: string } }
  | {
      response: Awaited<ReturnType<typeof reconcileDocumentCache>>['state'] & {
        cache: Awaited<ReturnType<typeof reconcileDocumentCache>>['cache'];
        cacheRun: ReturnType<DocumentCacheRunManager['start']>;
      };
    };

async function startDocumentCacheRun(
  options: TtsListenRouteOptions,
  key: ListenDocumentKey,
  input: CacheStartInput,
): Promise<CacheStartOutcome> {
  const current = options.repository.loadDocument(key);
  if (!current) return { error: { statusCode: 404, message: 'Listen document not found' } };
  const reconciled = await reconcileDocumentCache(options.cacheDir, options.repository, current);
  try {
    const cacheRun = options.cacheRuns.start({
      key,
      identity: input.identity,
      sentences: input.sentences,
      ...(input.synthesis ? { synthesis: input.synthesis } : {}),
      ...(input.startAnchor ? { startAnchor: input.startAnchor } : {}),
    });
    const state = options.repository.loadDocument(key) ?? reconciled.state;
    const next = await reconcileDocumentCache(options.cacheDir, options.repository, state);
    return { response: { ...next.state, cache: next.cache, cacheRun } };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to start document cache';
    return { error: { statusCode: message.includes('Listen document not found') ? 404 : 409, message } };
  }
}

export function registerTtsListenRoutes(app: FastifyInstance, options: TtsListenRouteOptions): void {
  const { cacheDir, repository, assets, cacheRuns } = options;

  app.get<{ Querystring: unknown }>('/api/tts/listen/document', async (request, reply) => {
    const userId = requireReadIdentity(request);
    if (!userId) return reply.status(401).send({ error: 'Identity required' });
    const parsed = documentKeySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues });
    const state = repository.loadDocument(documentKey(userId, parsed.data));
    if (!state) return reply.status(404).send({ error: 'Listen document not found' });
    const reconciled = await reconcileDocumentCache(cacheDir, repository, state);
    return {
      ...reconciled.state,
      cache: reconciled.cache,
      cacheRun: cacheRuns.status(documentKey(userId, parsed.data), reconciled.state),
    };
  });

  app.put<{ Body: unknown }>('/api/tts/listen/document', async (request, reply) => {
    const userId = requireWriteIdentity(request);
    if (!userId) return reply.status(401).send({ error: 'Identity required' });
    const parsed = documentWriteSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues });
    const key = documentKey(userId, parsed.data.identity);
    let synthesisFingerprint: string | undefined;
    try {
      synthesisFingerprint = assets.getSynthesisFingerprint(parsed.data.synthesis);
    } catch {
      // Persist the user's document state even while a local TTS provider is
      // unavailable. A later cache start computes the authoritative fingerprint.
    }
    const { synthesis: _synthesis, ...state } = parsed.data;
    const saved = { ...state, ...(synthesisFingerprint ? { synthesisFingerprint } : {}) };
    repository.saveDocument(key, saved);
    // saveDocument preserves a same-digest fingerprint while it is temporarily
    // unknown. Invalidate against that durable result, not the transient input.
    const persisted = repository.loadDocument(key) ?? saved;
    cacheRuns.invalidateStale(key, persisted);
    return persisted;
  });

  app.put<{ Body: unknown }>('/api/tts/listen/document/asset', async (request, reply) => {
    const userId = requireWriteIdentity(request);
    if (!userId) return reply.status(401).send({ error: 'Identity required' });
    const parsed = assetLinkSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues });
    const { anchor, assetId, contentDigest, synthesisFingerprint } = parsed.data;
    const key = documentKey(userId, parsed.data);
    try {
      if (contentDigest && synthesisFingerprint) {
        return {
          ok: true,
          linked: repository.setSentenceAssetIfCurrent(key, { contentDigest, synthesisFingerprint, anchor, assetId }),
        };
      }
      repository.setSentenceAsset(key, anchor, assetId);
      return { ok: true, linked: true };
    } catch (error) {
      return reply.status(404).send({ error: error instanceof Error ? error.message : 'Listen sentence not found' });
    }
  });

  app.post<{ Body: unknown }>('/api/tts/listen/document/cache', async (request, reply) => {
    const userId = requireWriteIdentity(request);
    if (!userId) return reply.status(401).send({ error: 'Identity required' });
    const parsed = cacheRunSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues });
    const key = documentKey(userId, parsed.data.identity);
    const outcome = await startDocumentCacheRun(options, key, parsed.data);
    if ('error' in outcome) return reply.status(outcome.error.statusCode).send({ error: outcome.error.message });
    return outcome.response;
  });

  app.delete<{ Body: unknown }>('/api/tts/listen/document/cache', async (request, reply) => {
    const userId = requireWriteIdentity(request);
    if (!userId) return reply.status(401).send({ error: 'Identity required' });
    const parsed = cacheCancelSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues });
    const key = documentKey(userId, parsed.data);
    const state = repository.loadDocument(key);
    if (!state) return reply.status(404).send({ error: 'Listen document not found' });
    const cancelled = cacheRuns.cancel(key, {
      contentDigest: parsed.data.contentDigest,
      synthesisFingerprint: parsed.data.synthesisFingerprint,
    });
    const reconciled = await reconcileDocumentCache(cacheDir, repository, state);
    return {
      ...reconciled.state,
      cache: reconciled.cache,
      cacheRun: cacheRuns.status(key, reconciled.state),
      cancelled,
    };
  });

  app.delete<{ Body: unknown }>('/api/tts/listen/document/audio', async (request, reply) => {
    const userId = requireWriteIdentity(request);
    if (!userId) return reply.status(401).send({ error: 'Identity required' });
    const parsed = documentKeySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues });
    try {
      const key = documentKey(userId, parsed.data);
      cacheRuns.cancel(key);
      const orphaned = repository.clearDocumentAudio(key);
      const deletion = await deleteOrphanedAssets(cacheDir, repository, orphaned);
      const result = { clearedReferences: orphaned.length, ...deletion };
      if (deletion.failed > 0) {
        return reply.status(500).send({ error: 'Failed to delete one or more listen audio assets', ...result });
      }
      return result;
    } catch (error) {
      return reply.status(404).send({ error: error instanceof Error ? error.message : 'Listen document not found' });
    }
  });
}
