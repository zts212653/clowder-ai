import { stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ListenDocumentState } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  DocumentListenRepository,
  ListenDocumentKey,
} from '../domains/cats/services/tts/DocumentListenRepository.js';
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
const assetLinkSchema = documentKeySchema.extend({
  anchor: z.string().min(1).max(256),
  assetId: z.string().regex(AUDIO_ASSET_ID_RE),
});

interface TtsListenRouteOptions {
  cacheDir: string;
  repository: DocumentListenRepository;
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

export function registerTtsListenRoutes(app: FastifyInstance, options: TtsListenRouteOptions): void {
  const { cacheDir, repository } = options;

  app.get<{ Querystring: unknown }>('/api/tts/listen/document', async (request, reply) => {
    const userId = requireReadIdentity(request);
    if (!userId) return reply.status(401).send({ error: 'Identity required' });
    const parsed = documentKeySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues });
    const state = repository.loadDocument(documentKey(userId, parsed.data));
    if (!state) return reply.status(404).send({ error: 'Listen document not found' });
    const reconciled = await reconcileDocumentCache(cacheDir, repository, state);
    return { ...reconciled.state, cache: reconciled.cache };
  });

  app.put<{ Body: unknown }>('/api/tts/listen/document', async (request, reply) => {
    const userId = requireWriteIdentity(request);
    if (!userId) return reply.status(401).send({ error: 'Identity required' });
    const parsed = documentStateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues });
    repository.saveDocument(documentKey(userId, parsed.data.identity), parsed.data);
    return parsed.data;
  });

  app.put<{ Body: unknown }>('/api/tts/listen/document/asset', async (request, reply) => {
    const userId = requireWriteIdentity(request);
    if (!userId) return reply.status(401).send({ error: 'Identity required' });
    const parsed = assetLinkSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues });
    const { anchor, assetId, ...identity } = parsed.data;
    try {
      repository.setSentenceAsset(documentKey(userId, identity), anchor, assetId);
      return { ok: true };
    } catch (error) {
      return reply.status(404).send({ error: error instanceof Error ? error.message : 'Listen sentence not found' });
    }
  });

  app.delete<{ Body: unknown }>('/api/tts/listen/document/audio', async (request, reply) => {
    const userId = requireWriteIdentity(request);
    if (!userId) return reply.status(401).send({ error: 'Identity required' });
    const parsed = documentKeySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues });
    try {
      const orphaned = repository.clearDocumentAudio(documentKey(userId, parsed.data));
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
