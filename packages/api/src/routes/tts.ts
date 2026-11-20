/**
 * F34: TTS Routes
 *
 * POST /api/tts/synthesize — Synthesize text to speech, returns audioUrl
 * POST /api/tts/resynthesize — Re-attempt TTS for a failed voice block (F066 Phase 4)
 * POST /api/tts/stream    — F111: SSE streaming synthesis (chunked audio)
 * GET  /api/tts/audio/:filename — Download audio file (auth-gated)
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat as fsStat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ITtsProvider, TtsStreamEvent, TtsSynthesizeRequest } from '@cat-cafe/shared';
import { parsePcm16Wav } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getCatVoiceOptions } from '../config/cat-voice-options.js';
import { resolveCatVoice } from '../config/cat-voices.js';
import {
  cachedVoiceSelection,
  completeVoiceSelection,
  prepareCatVoice,
  ReferenceAudioChangedError,
  VoiceSelectionSequence,
} from '../domains/cats/services/tts/cat-voice-synthesis.js';
import { DocumentCacheRunManager } from '../domains/cats/services/tts/DocumentCacheRunManager.js';
import type { DocumentListenRepository } from '../domains/cats/services/tts/DocumentListenRepository.js';
import {
  type IndexedListenChunk,
  type ListenAsset,
  ListenAssetService,
  type PreparedListenSynthesis,
} from '../domains/cats/services/tts/ListenAssetService.js';
import { pcm16WavDurationSec, trimAudiblePcm16Prefix } from '../domains/cats/services/tts/listen-audio-postprocess.js';
import {
  independentAudioHash,
  referenceAudioCacheIdentity,
} from '../domains/cats/services/tts/reference-audio-cache.js';
import { ttsUnavailableResponse } from '../domains/cats/services/tts/TtsCacheIdentityError.js';
import { chunkStaticTtsText, chunkText } from '../domains/cats/services/tts/TtsChunker.js';
import type { TtsRegistry } from '../domains/cats/services/tts/TtsRegistry.js';
import { canReuseVoiceAsset, writeAssetVoiceReceipt } from '../domains/cats/services/tts/tts-asset-provenance.js';
import { getVoiceBlockSynthesizer } from '../domains/cats/services/tts/VoiceBlockSynthesizer.js';
import { applySecurityHeaders } from '../infrastructure/security-headers.js';
import { resolveUserId } from '../utils/request-identity.js';
import { registerTtsListenRoutes } from './tts-listen-routes.js';

const synthesizeSchema = z.object({
  text: z.string().min(1).max(20000),
  catId: z.string().optional(),
  voice: z.string().optional(),
  langCode: z.string().optional(),
  speed: z.number().min(0.5).max(2.0).optional(),
  purpose: z.literal('listen').optional(),
});

const listenStreamSchema = synthesizeSchema.extend({
  purpose: z.enum(['listen', 'read-aloud']).optional(),
  streamPcm: z.literal(true).optional(),
});

const sentenceSegmenter = new Intl.Segmenter(['zh', 'en'], { granularity: 'sentence' });

function readAloudSegments(text: string): string[] {
  const trimmed = text.trim();
  const first = sentenceSegmenter.segment(trimmed).containing(0)?.segment ?? trimmed;
  // Start with a complete sentence, then reuse the existing bounded TTS packing.
  return [...chunkStaticTtsText(first), ...chunkStaticTtsText(trimmed.slice(first.length))];
}

/** Strict validation for audio download filename: {64-hex}.{wav|mp3} */
const AUDIO_FILENAME_RE = /^[0-9a-f]{64}\.(wav|mp3)$/;

function synthesisHash(
  provider: Pick<ITtsProvider, 'id' | 'model' | 'cacheIdentity'>,
  request: TtsSynthesizeRequest,
  variant?: string,
): string {
  const parts = [
    provider.id,
    provider.cacheIdentity ?? provider.model,
    request.voice,
    request.langCode ?? 'z',
    String(request.speed ?? 1),
    request.format ?? 'wav',
    request.text,
  ];
  if (request.refAudio)
    parts.push(request.refAudio, referenceAudioCacheIdentity(request.refAudio, request.refAudioData?.sha256));
  if (request.refText) parts.push(request.refText);
  if (request.instruct) parts.push(request.instruct);
  if (request.temperature != null) parts.push(String(request.temperature));
  const baseHash = createHash('sha256')
    .update(request.refAudioData ? JSON.stringify(parts) : parts.join('|'))
    .digest('hex');
  if (!variant) return baseHash;
  return createHash('sha256').update(`${baseHash}\0variant:${variant}`).digest('hex');
}

async function findCachedAudio(cacheDir: string, hash: string, requestedFormat: 'wav' | 'mp3') {
  for (const ext of [requestedFormat, requestedFormat === 'wav' ? 'mp3' : 'wav']) {
    const candidatePath = path.join(cacheDir, `${hash}.${ext}`);
    try {
      const fileStat = await fsStat(candidatePath);
      return { filePath: candidatePath, bytes: fileStat.size };
    } catch {
      // Try the alternate supported format.
    }
  }
  return null;
}

function sendListenEvent(reply: FastifyReply, event: object): void {
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

function startTtsEventStream(reply: FastifyReply): void {
  // raw.writeHead bypasses Fastify's reply serialization, so preserve headers
  // installed by hooks and apply the shared onSend security-header policy now.
  applySecurityHeaders(reply);
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) reply.raw.setHeader(name, value);
  }
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
}

function isOpenTtsStream(reply: FastifyReply): boolean {
  return !reply.raw.destroyed && !reply.raw.writableEnded;
}

function sendListenAsset(reply: FastifyReply, asset: ListenAsset, pcmChunkCount = 0): void {
  if (isOpenTtsStream(reply))
    sendListenEvent(reply, { type: 'asset', ...asset, ...(pcmChunkCount ? { pcmChunkCount } : {}) });
}

function sendWorkspaceListenChunk(reply: FastifyReply, chunk: IndexedListenChunk): void {
  if (!isOpenTtsStream(reply)) return;
  sendListenEvent(reply, {
    type: 'chunk',
    audioBase64: Buffer.from(chunk.audio).toString('base64'),
    format: chunk.format,
    durationSec: chunk.durationSec,
    isFinalChunk: chunk.isFinalChunk,
    voiceSelection: chunk.voiceSelection,
  });
}

function readablePcmSampleRate(event: IndexedListenChunk): number | undefined {
  const format = event.format === 'wav' ? parsePcm16Wav(event.audio) : null;
  if (format?.channels === 1 && format.blockAlign === 2 && format.dataSize > 0) return format.sampleRate;
}

function readAloudPcmChunks(reply: FastifyReply, voice: VoiceSelectionSequence, needsReference: boolean) {
  let count = 0;
  let sampleRate: number | undefined;
  let forwarding = true;
  let failure: unknown;
  return {
    onChunk(event: IndexedListenChunk) {
      if (!forwarding || !isOpenTtsStream(reply)) return;
      const rate = readablePcmSampleRate(event);
      const verifiedVoice = !needsReference || event.voiceSelection?.referenceStatus === 'sent';
      // A late subscriber in a shared flight is missing the audio prefix.
      if (!rate || (sampleRate !== undefined && rate !== sampleRate) || !verifiedVoice || event.chunkIndex !== count) {
        forwarding = false;
        if (count) failure = new Error('Read-aloud PCM became unavailable mid-sentence');
        return;
      }
      const audio = count === 0 ? trimAudiblePcm16Prefix(event.audio) : event.audio;
      if (!audio) {
        forwarding = false;
        return;
      }
      try {
        if (event.voiceSelection) voice.observe(event.voiceSelection);
      } catch (error) {
        forwarding = false;
        failure = error;
        return;
      }
      sampleRate = rate;
      count++;
      sendListenEvent(reply, {
        type: 'chunk',
        audioBase64: Buffer.from(audio).toString('base64'),
        format: event.format,
        durationSec: pcm16WavDurationSec(audio),
        isFinalChunk: event.isFinalChunk,
        chunkIndex: event.chunkIndex,
      });
    },
    finish() {
      if (failure) throw failure;
      return count;
    },
  };
}

function logListenAsset(request: FastifyRequest, asset: ListenAsset): void {
  request.log.info(
    {
      feature: 'F279',
      assetId: asset.assetId,
      cache_hit: asset.cached,
      cache_miss: !asset.cached,
      ...(!asset.cached ? { cache_miss_reason: 'asset_not_found', synthesis_ms: asset.synthesisMs } : {}),
      ...(asset.durationSec && asset.durationSec > 0
        ? {
            duration_sec: asset.durationSec,
            tts_synthesis_rtf: (asset.synthesisMs ?? 0) / (asset.durationSec * 1000),
          }
        : {}),
    },
    '[F279] listen TTS stream asset',
  );
}

function reportListenStreamFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  controller: AbortController,
  error: unknown,
): void {
  if (controller.signal.aborted) {
    request.log.info('[F279] listen TTS stream cancelled after client disconnect');
    return;
  }
  request.log.error({ err: error }, '[F279] listen TTS stream failed');
  if (isOpenTtsStream(reply)) {
    sendListenEvent(reply, { type: 'error', error: error instanceof Error ? error.message : 'TTS stream failed' });
  }
}

async function streamListenAssets(options: {
  request: FastifyRequest;
  reply: FastifyReply;
  assets: ListenAssetService;
  segments: string[];
  preparedSynthesis: PreparedListenSynthesis;
  readAloud: boolean;
  streamPcm: boolean;
}): Promise<void> {
  const controller = new AbortController();
  const abortOnClose = () => controller.abort(new Error('Listen client disconnected'));
  options.reply.raw.once('close', abortOnClose);
  const voiceSequence = new VoiceSelectionSequence();
  try {
    for (const text of options.segments) {
      if (!isOpenTtsStream(options.reply)) break;
      const chunks = options.streamPcm
        ? readAloudPcmChunks(options.reply, voiceSequence, !!options.preparedSynthesis.request.refAudio)
        : undefined;
      const asset = await options.assets.getOrCreate(text, {
        preparedSynthesis: options.preparedSynthesis,
        signal: controller.signal,
        onChunk: options.readAloud ? undefined : (event) => sendWorkspaceListenChunk(options.reply, event),
        onEarlyChunk: chunks?.onChunk,
      });
      const pcmChunkCount = chunks?.finish() ?? 0;
      if (options.readAloud && asset.voiceSelection) voiceSequence.observe(asset.voiceSelection);
      sendListenAsset(options.reply, asset, pcmChunkCount);
      logListenAsset(options.request, asset);
    }
  } catch (error) {
    reportListenStreamFailure(options.request, options.reply, controller, error);
  } finally {
    options.reply.raw.removeListener('close', abortOnClose);
    if (isOpenTtsStream(options.reply)) options.reply.raw.end();
  }
}

async function handleListenStream(
  request: FastifyRequest<{ Body: unknown }>,
  reply: FastifyReply,
  options: { assets: ListenAssetService },
): Promise<void> {
  if (!resolveUserId(request)) {
    await reply.status(401).send({ error: 'Identity required' });
    return;
  }
  const parsed = listenStreamSchema.safeParse(request.body);
  if (!parsed.success) {
    await reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const { text, purpose, streamPcm, ...synthesis } = parsed.data;
  const readAloud = purpose === 'read-aloud';
  const segments = readAloud ? readAloudSegments(text) : [text];
  if (segments.length === 0) {
    await reply.status(400).send({ error: 'No text to synthesize' });
    return;
  }
  let preparedSynthesis: PreparedListenSynthesis;
  try {
    // Resolve before sending SSE headers so an unavailable provider remains a
    // regular API failure instead of a late stream error.
    preparedSynthesis = await options.assets.prepareSynthesis(synthesis);
  } catch (error) {
    await reply.status(503).send(ttsUnavailableResponse(error));
    return;
  }

  startTtsEventStream(reply);
  if (readAloud && streamPcm) reply.raw.flushHeaders();
  await streamListenAssets({
    request,
    reply,
    assets: options.assets,
    segments,
    preparedSynthesis,
    readAloud,
    streamPcm: readAloud && streamPcm === true,
  });
}

export interface TtsRouteOptions extends FastifyPluginOptions {
  ttsRegistry: TtsRegistry;
  cacheDir: string;
  documentListenRepository?: DocumentListenRepository;
}

export async function ttsRoutes(app: FastifyInstance, opts: TtsRouteOptions): Promise<void> {
  const { ttsRegistry, cacheDir, documentListenRepository } = opts;

  // Ensure cache directory exists
  await mkdir(cacheDir, { recursive: true });
  const listenAssets = new ListenAssetService(ttsRegistry, cacheDir);
  const cacheRuns = documentListenRepository
    ? new DocumentCacheRunManager(documentListenRepository, listenAssets)
    : undefined;
  app.addHook('onClose', async () => {
    cacheRuns?.close();
    await listenAssets.close();
  });

  app.get('/api/tts/voices', async (request, reply) => {
    if (!resolveUserId(request)) return reply.code(401).send({ error: 'Identity required' });
    const query = z.object({ catId: z.string().min(1).max(64).optional() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Invalid request' });
    try {
      return {
        voices: getCatVoiceOptions(),
        ...(query.data.catId ? { resolution: resolveCatVoice(query.data.catId) } : {}),
      };
    } catch (error) {
      request.log.error({ err: error }, 'Voice choices unavailable');
      return reply.code(503).send({ error: 'Voice choices unavailable' });
    }
  });

  /**
   * POST /api/tts/synthesize
   * Synthesize text to speech for a cat.
   */
  app.post<{ Body: unknown }>('/api/tts/synthesize', async (request, reply) => {
    // Auth gate
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    // Validate body
    const parsed = synthesizeSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    const {
      text,
      catId,
      voice: voiceOverride,
      langCode: langCodeOverride,
      speed: speedOverride,
      purpose,
    } = parsed.data;

    if (purpose === 'listen') {
      try {
        const asset = await listenAssets.getOrCreate(text, {
          synthesis: {
            ...(catId ? { catId } : {}),
            ...(voiceOverride ? { voice: voiceOverride } : {}),
            ...(langCodeOverride ? { langCode: langCodeOverride } : {}),
            ...(speedOverride != null ? { speed: speedOverride } : {}),
          },
        });
        request.log.info(
          {
            feature: 'F279',
            assetId: asset.assetId,
            cache_hit: asset.cached,
            cache_miss: !asset.cached,
            ...(!asset.cached ? { cache_miss_reason: 'asset_not_found', synthesis_ms: asset.synthesisMs } : {}),
            ...(asset.durationSec && asset.durationSec > 0
              ? {
                  duration_sec: asset.durationSec,
                  tts_synthesis_rtf: (asset.synthesisMs ?? 0) / (asset.durationSec * 1000),
                }
              : {}),
          },
          '[F279] listen TTS asset',
        );
        return asset;
      } catch (err) {
        request.log.error({ err }, 'TTS listen synthesis failed');
        reply.status(err instanceof Error && err.message.includes('No TTS provider') ? 503 : 502);
        return { error: 'TTS synthesis failed', detail: err instanceof Error ? err.message : 'unknown' };
      }
    }

    const requestedFormat = 'wav';

    // Get provider
    let provider: ITtsProvider;
    try {
      provider = ttsRegistry.getDefault();
      provider = (await provider.snapshot?.({ cacheDir })) ?? provider;
    } catch (error) {
      reply.status(503);
      return ttsUnavailableResponse(error);
    }

    const { request: voiceRequest, voiceSelection } = prepareCatVoice(
      catId ?? 'opus',
      provider,
      {
        ...(voiceOverride !== undefined ? { voice: voiceOverride } : {}),
        ...(langCodeOverride !== undefined ? { langCode: langCodeOverride } : {}),
        ...(speedOverride !== undefined ? { speed: speedOverride } : {}),
      },
      cacheDir,
    );
    const synthRequest: TtsSynthesizeRequest = { ...voiceRequest, text };
    let actualVoiceSelection = voiceSelection;
    if (voiceSelection.warnings.length) request.log.warn({ voiceSelection }, 'TTS voice fallback or uncertainty');
    const hash = synthesisHash(provider, synthRequest);

    // First try cache with requested format, then try with alternate format
    let filePath: string | undefined;
    let cached = false;
    let durationSec: number | undefined;
    const found =
      !synthRequest.refAudio || synthRequest.refAudioData
        ? await findCachedAudio(cacheDir, hash, requestedFormat)
        : null;
    const cachedAudio =
      found && (await canReuseVoiceAsset(cacheDir, path.basename(found.filePath), voiceSelection)) ? found : null;
    if (cachedAudio) {
      filePath = cachedAudio.filePath;
      cached = true;
    }

    if (!cached) {
      // Synthesize
      try {
        const result = await provider.synthesize(synthRequest);
        actualVoiceSelection = completeVoiceSelection(voiceSelection, result.referenceAudio, provider);
        durationSec = result.durationSec;
        // Double-check: only allow known audio extensions (defense in depth)
        const allowedFormats = new Set(['wav', 'mp3']);
        const actualFormat = allowedFormats.has(result.format) ? result.format : requestedFormat;
        const publishedHash =
          synthRequest.refAudioData && actualVoiceSelection.referenceStatus !== 'sent'
            ? independentAudioHash(hash)
            : hash;
        const fname = `${publishedHash}.${actualFormat}`;
        filePath = path.join(cacheDir, fname);
        await writeFile(filePath, result.audio);
        await writeAssetVoiceReceipt(
          cacheDir,
          fname,
          actualVoiceSelection,
          !synthRequest.refAudio || actualVoiceSelection.referenceStatus === 'sent',
        );
      } catch (err) {
        request.log.error({ err, voiceSelection }, 'TTS synthesis failed');
        reply.status(502);
        return { error: 'TTS synthesis failed', detail: err instanceof Error ? err.message : 'unknown' };
      }
    }

    // filePath is always set: either from cache lookup or synthesis
    const resolvedFilename = path.basename(filePath ?? '');
    const resolvedStat = await fsStat(filePath ?? '');
    return {
      audioUrl: `/api/tts/audio/${resolvedFilename}`,
      assetId: resolvedFilename,
      cached,
      bytes: resolvedStat.size,
      voiceSelection: cached ? cachedVoiceSelection(voiceSelection) : actualVoiceSelection,
      ...(durationSec != null ? { durationSec } : {}),
    };
  });

  app.post<{ Body: unknown }>('/api/tts/listen/stream', (request, reply) =>
    handleListenStream(request, reply, { assets: listenAssets }),
  );

  // ── F066 Phase 4: Resynthesize endpoint ─────────────────────

  const resynthesizeSchema = z.object({
    text: z.string().min(1).max(20000),
    catId: z.string().min(1),
  });

  /**
   * POST /api/tts/resynthesize
   * Re-attempt TTS synthesis for a failed voice block.
   * Called by the frontend "重新合成" button on 🔇 warning cards.
   */
  app.post<{ Body: unknown }>('/api/tts/resynthesize', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const parsed = resynthesizeSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }

    const synthesizer = getVoiceBlockSynthesizer();
    if (!synthesizer) {
      reply.status(503);
      return { error: 'Voice synthesizer not initialized' };
    }

    try {
      const result = await synthesizer.resynthesize(parsed.data.text, parsed.data.catId);
      return { audioUrl: result.audioUrl, durationSec: result.durationSec, voiceSelection: result.voiceSelection };
    } catch (err) {
      request.log.error({ err }, 'TTS resynthesize failed');
      reply.status(502);
      return { error: 'TTS resynthesize failed', detail: err instanceof Error ? err.message : 'unknown' };
    }
  });

  // ── F111: SSE Streaming synthesis endpoint ─────────────────────

  const streamSchema = z.object({
    text: z.string().min(1).max(50000),
    catId: z.string().optional(),
    voice: z.string().optional(),
    langCode: z.string().optional(),
    speed: z.number().min(0.5).max(2.0).optional(),
  });

  app.post<{ Body: unknown }>('/api/tts/stream', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const parsed = streamSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }

    const { text, catId, voice: voiceOverride, langCode: langCodeOverride, speed: speedOverride } = parsed.data;

    let provider: ITtsProvider;
    try {
      provider = ttsRegistry.getDefault();
      provider = (await provider.snapshot?.({ cacheDir })) ?? provider;
    } catch (error) {
      reply.status(503);
      return ttsUnavailableResponse(error);
    }

    const { request: voiceRequest, voiceSelection } = prepareCatVoice(
      catId ?? 'opus',
      provider,
      {
        ...(voiceOverride !== undefined ? { voice: voiceOverride } : {}),
        ...(langCodeOverride !== undefined ? { langCode: langCodeOverride } : {}),
        ...(speedOverride !== undefined ? { speed: speedOverride } : {}),
      },
      cacheDir,
    );

    const chunks = chunkText(text);
    if (chunks.length === 0) {
      reply.status(400);
      return { error: 'No text to synthesize after chunking' };
    }

    startTtsEventStream(reply);

    const sendEvent = (event: TtsStreamEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const startTime = Date.now();
    let successfulChunks = 0;
    let completedSelection: import('@cat-cafe/shared').TtsVoiceSelection | undefined;
    const sequence = new VoiceSelectionSequence();

    for (let i = 0; i < chunks.length; i++) {
      if (reply.raw.destroyed || reply.raw.writableEnded) {
        request.log.info({ index: i, total: chunks.length }, '[TTS-STREAM] client disconnected, aborting');
        return;
      }

      const chunk = chunks[i];
      try {
        const synthRequest: TtsSynthesizeRequest = { ...voiceRequest, text: chunk.text };

        const chunkStart = Date.now();
        const result = await provider.synthesize(synthRequest);
        const actualVoiceSelection = completeVoiceSelection(voiceSelection, result.referenceAudio, provider);
        completedSelection = sequence.observe(actualVoiceSelection);
        const chunkMs = Date.now() - chunkStart;

        if (reply.raw.destroyed || reply.raw.writableEnded) {
          request.log.info({ index: i, total: chunks.length }, '[TTS-STREAM] client disconnected after synthesis');
          return;
        }

        const audioBase64 = Buffer.from(result.audio).toString('base64');

        if (i === 0) {
          request.log.info({ latencyMs: Date.now() - startTime, boost: chunk.isBoost }, '[TTS-STREAM] first chunk');
        }
        request.log.info(
          { index: i, total: chunks.length, chunkMs, boost: chunk.isBoost, textLen: chunk.text.length },
          '[TTS-STREAM] chunk synthesized',
        );

        sendEvent({
          type: 'chunk',
          index: successfulChunks,
          total: chunks.length,
          sourceIndex: i,
          sourceTotal: chunks.length,
          audioBase64,
          text: chunk.text,
          durationSec: result.durationSec,
          format: result.format,
          voiceSelection: actualVoiceSelection,
        });
        successfulChunks++;
      } catch (err) {
        if (err instanceof ReferenceAudioChangedError) {
          sendEvent({ type: 'error', error: err.message });
          reply.raw.end();
          return;
        }
        request.log.error({ err, index: i, total: chunks.length }, '[TTS-STREAM] chunk synthesis failed, skipping');
      }
    }

    if (successfulChunks === 0) {
      request.log.error({ totalMs: Date.now() - startTime, chunks: chunks.length }, '[TTS-STREAM] all chunks failed');
      sendEvent({ type: 'error', error: 'All chunks failed synthesis' });
    } else {
      request.log.info(
        { totalMs: Date.now() - startTime, chunks: chunks.length, successfulChunks },
        '[TTS-STREAM] complete',
      );
      sendEvent({ type: 'done', total: successfulChunks, voiceSelection: completedSelection ?? voiceSelection });
    }
    reply.raw.end();
  });

  /**
   * GET /api/tts/audio/:filename
   * Auth-gated audio download (R2-P1: not served via public /uploads/).
   */
  app.get<{ Params: { filename: string } }>('/api/tts/audio/:filename', async (request, reply) => {
    // Auth gate
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const { filename } = request.params;

    // R3-P1: Strict filename validation — 64-hex hash + wav/mp3 extension
    if (!AUDIO_FILENAME_RE.test(filename)) {
      reply.status(400);
      return { error: 'Invalid audio filename' };
    }

    // R3-P1: Safe path join + prefix verification
    const resolvedPath = path.resolve(cacheDir, filename);
    if (!resolvedPath.startsWith(path.resolve(cacheDir))) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    // Check file exists
    try {
      await fsStat(resolvedPath);
      documentListenRepository?.touchAsset(filename);
    } catch {
      reply.status(404);
      return { error: 'Audio not found' };
    }

    // Determine MIME type
    const ext = path.extname(filename).slice(1);
    const mimeType = ext === 'mp3' ? 'audio/mpeg' : 'audio/wav';

    reply.header('Content-Type', mimeType);
    reply.header('Cache-Control', 'private, max-age=86400');
    return reply.send(createReadStream(resolvedPath));
  });

  if (documentListenRepository && cacheRuns) {
    registerTtsListenRoutes(app, {
      cacheDir,
      repository: documentListenRepository,
      assets: listenAssets,
      cacheRuns,
    });
  }
}
