import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { ListenDocumentState } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DocumentCacheRunManager } from '../domains/cats/services/tts/DocumentCacheRunManager.js';
import {
  type DocumentListenRepository,
  ListenAssetUnavailableError,
  type ListenDocumentKey,
} from '../domains/cats/services/tts/DocumentListenRepository.js';
import type { ListenAssetService, PreparedListenSynthesis } from '../domains/cats/services/tts/ListenAssetService.js';
import { ListenDocumentMutationQueue } from '../domains/cats/services/tts/ListenDocumentMutationQueue.js';
import { deleteAudioFileSync, inspectAudioFileSync } from '../domains/cats/services/tts/tts-asset-cleanup.js';
import { canLinkReusableAsset, readListenRecording } from '../domains/cats/services/tts/tts-asset-provenance.js';
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
      repository.removeAssetWhen(assetId, (policy) => {
        if (policy && policy.referenceCount > 0) return false;
        const result = deleteAudioFileSync(path.join(cacheDir, assetId));
        if (result?.deleted) deleted++;
        return result !== undefined;
      });
    } catch {
      failed++;
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
  const recordings: Record<string, Awaited<ReturnType<typeof readListenRecording>>> = {};
  for (const assetId of assetIds) {
    if (!AUDIO_ASSET_ID_RE.test(assetId)) continue;
    const filePath = path.join(cacheDir, assetId);
    let present: Stats | undefined;
    let unavailable = false;
    try {
      const fileStat = await stat(filePath);
      if (fileStat.isFile()) present = fileStat;
      else unavailable = true;
    } catch (error) {
      unavailable = (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
    if (unavailable) {
      repository.removeAssetWhen(assetId, () => inspectAudioFileSync(filePath) === 'missing');
      const current = inspectAudioFileSync(filePath);
      if (typeof current !== 'string') present = current;
    }
    if (present) {
      availableSizes.set(assetId, present.size);
      recordings[assetId] = await readListenRecording(cacheDir, assetId, present.size);
    }
  }
  const sentences = state.sentences.map(({ anchor, assetId }) => ({
    anchor,
    ...(assetId && availableSizes.has(assetId) ? { assetId } : {}),
  }));
  return {
    state: { ...state, sentences, recordings },
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
    const synthesis = await options.assets.prepareSynthesis(input.synthesis);
    const cacheRun = options.cacheRuns.start({
      key,
      identity: input.identity,
      sentences: input.sentences,
      synthesis,
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
  const mutations = new ListenDocumentMutationQueue();
  const assetAvailable = (assetId: string) => assets.isAssetAvailable(assetId);

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
    return mutations.run(key, async () => {
      const previous = repository.loadDocument(key);
      for (const sentence of parsed.data.sentences) {
        const retained = previous?.sentences.some(
          (old) => old.anchor === sentence.anchor && old.assetId === sentence.assetId,
        );
        if (sentence.assetId && !retained && !(await canLinkReusableAsset(cacheDir, sentence.assetId)))
          return reply.status(409).send({ error: '本次资产缺少可复用声线回执；已有文档录音保持原关联。' });
      }
      let synthesisFingerprint: string | undefined;
      let synthesis: PreparedListenSynthesis | undefined;
      try {
        synthesis = await assets.prepareSynthesis(parsed.data.synthesis);
        synthesisFingerprint = synthesis.fingerprint;
      } catch {
        // Persist state even when the provider is temporarily unavailable.
      }
      const { synthesis: _synthesis, ...state } = parsed.data;
      const saved = { ...state, ...(synthesisFingerprint ? { synthesisFingerprint } : {}) };
      try {
        repository.saveDocument(key, saved, synthesis?.legacyFingerprint, assetAvailable);
      } catch (error) {
        if (error instanceof ListenAssetUnavailableError) return reply.status(409).send({ error: error.message });
        throw error;
      }
      // Invalidate against the durable fingerprint, which saveDocument may
      // preserve while the current provider identity is temporarily unknown.
      const persisted = repository.loadDocument(key) ?? saved;
      cacheRuns.invalidateStale(key, persisted);
      return persisted;
    });
  });

  app.put<{ Body: unknown }>('/api/tts/listen/document/asset', async (request, reply) => {
    const userId = requireWriteIdentity(request);
    if (!userId) return reply.status(401).send({ error: 'Identity required' });
    const parsed = assetLinkSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues });
    const { anchor, assetId, contentDigest, synthesisFingerprint } = parsed.data;
    const key = documentKey(userId, parsed.data);
    return mutations.run(key, async () => {
      const retained = repository
        .loadDocument(key)
        ?.sentences.some((old) => old.anchor === anchor && old.assetId === assetId);
      if (!retained && !(await canLinkReusableAsset(cacheDir, assetId)))
        return reply.status(409).send({ error: '本次资产缺少可复用声线回执；已有文档录音保持原关联。' });
      try {
        if (contentDigest && synthesisFingerprint) {
          return {
            ok: true,
            linked: repository.setSentenceAssetIfCurrent(
              key,
              { contentDigest, synthesisFingerprint, anchor, assetId },
              assetAvailable,
            ),
          };
        }
        repository.setSentenceAsset(key, anchor, assetId, Date.now(), assetAvailable);
        return { ok: true, linked: true };
      } catch (error) {
        return reply
          .status(error instanceof ListenAssetUnavailableError ? 409 : 404)
          .send({ error: error instanceof Error ? error.message : 'Listen sentence not found' });
      }
    });
  });

  app.post<{ Body: unknown }>('/api/tts/listen/document/cache', async (request, reply) => {
    const userId = requireWriteIdentity(request);
    if (!userId) return reply.status(401).send({ error: 'Identity required' });
    const parsed = cacheRunSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues });
    const key = documentKey(userId, parsed.data.identity);
    const outcome = await mutations.run(key, () => startDocumentCacheRun(options, key, parsed.data));
    if ('error' in outcome) return reply.status(outcome.error.statusCode).send({ error: outcome.error.message });
    return outcome.response;
  });

  app.delete<{ Body: unknown }>('/api/tts/listen/document/cache', async (request, reply) => {
    const userId = requireWriteIdentity(request);
    if (!userId) return reply.status(401).send({ error: 'Identity required' });
    const parsed = cacheCancelSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues });
    const key = documentKey(userId, parsed.data);
    return mutations.run(key, async () => {
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
  });

  app.delete<{ Body: unknown }>('/api/tts/listen/document/audio', async (request, reply) => {
    const userId = requireWriteIdentity(request);
    if (!userId) return reply.status(401).send({ error: 'Identity required' });
    const parsed = documentKeySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues });
    const key = documentKey(userId, parsed.data);
    return mutations.run(key, async () => {
      try {
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
  });
}
