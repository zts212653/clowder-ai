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
import type {
  ITtsProvider,
  TtsStreamEvent,
  TtsSynthesizeRequest,
  TtsSynthesizeResult,
  TtsSynthesizeStreamEvent,
} from '@cat-cafe/shared';
import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getCatVoice } from '../config/cat-voices.js';
import type { DocumentListenRepository } from '../domains/cats/services/tts/DocumentListenRepository.js';
import {
  LISTEN_AUDIO_CACHE_VERSION,
  pcm16WavDurationSec,
  trimLeadingPcm16Wav,
} from '../domains/cats/services/tts/listen-audio-postprocess.js';
import { chunkText } from '../domains/cats/services/tts/TtsChunker.js';
import type { TtsRegistry } from '../domains/cats/services/tts/TtsRegistry.js';
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

/** Strict validation for audio download filename: {64-hex}.{wav|mp3} */
const AUDIO_FILENAME_RE = /^[0-9a-f]{64}\.(wav|mp3)$/;
const AUDIO_FORMATS = ['wav', 'mp3'] as const;

function synthesisHash(
  provider: Pick<ITtsProvider, 'id' | 'model'>,
  request: TtsSynthesizeRequest,
  variant?: string,
): string {
  const parts = [
    provider.id,
    provider.model,
    request.voice,
    request.langCode ?? 'z',
    String(request.speed ?? 1),
    request.format ?? 'wav',
    request.text,
  ];
  if (request.refAudio) parts.push(request.refAudio);
  if (request.refText) parts.push(request.refText);
  if (request.instruct) parts.push(request.instruct);
  if (request.temperature != null) parts.push(String(request.temperature));
  const baseHash = createHash('sha256').update(parts.join('|')).digest('hex');
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

interface ListenAssetEvent {
  type: 'asset';
  audioUrl: string;
  assetId: string;
  cached: boolean;
  bytes: number;
  durationSec?: number;
  synthesisMs?: number;
}

async function synthesizeAndCacheListenAsset(options: {
  provider: ITtsProvider;
  request: TtsSynthesizeRequest;
  cacheDir: string;
  hash: string;
  onChunk: (event: Extract<TtsSynthesizeStreamEvent, { type: 'chunk' }>) => void;
  signal?: AbortSignal;
}): Promise<ListenAssetEvent> {
  const startedAt = Date.now();
  let finalResult: TtsSynthesizeResult | null = null;
  if (options.provider.stream) {
    for await (const event of options.provider.stream(options.request, { signal: options.signal })) {
      if (event.type === 'chunk') options.onChunk(event);
      else finalResult = event.result;
    }
  } else {
    finalResult = await options.provider.synthesize(options.request);
  }
  options.signal?.throwIfAborted();
  if (!finalResult) throw new Error('TTS stream completed without a final cache asset');

  const actualFormat = AUDIO_FORMATS.includes(finalResult.format as (typeof AUDIO_FORMATS)[number])
    ? finalResult.format
    : 'wav';
  const audio = actualFormat === 'wav' ? trimLeadingPcm16Wav(finalResult.audio) : finalResult.audio;
  const durationSec =
    actualFormat === 'wav' ? (pcm16WavDurationSec(audio) ?? finalResult.durationSec) : finalResult.durationSec;
  const assetId = `${options.hash}.${actualFormat}`;
  await writeFile(path.join(options.cacheDir, assetId), audio);
  return {
    type: 'asset',
    audioUrl: `/api/tts/audio/${assetId}`,
    assetId,
    cached: false,
    bytes: audio.byteLength,
    ...(durationSec != null ? { durationSec } : {}),
    synthesisMs: Date.now() - startedAt,
  };
}

function buildListenSynthesisRequest(body: z.infer<typeof synthesizeSchema>): TtsSynthesizeRequest {
  const catVoice = getCatVoice(body.catId ?? 'opus');
  return {
    text: body.text,
    voice: body.voice ?? catVoice.voice,
    langCode: body.langCode ?? catVoice.langCode,
    speed: body.speed ?? catVoice.speed ?? 1,
    format: 'wav',
    ...(catVoice.refAudio ? { refAudio: catVoice.refAudio } : {}),
    ...(catVoice.refText ? { refText: catVoice.refText } : {}),
    ...(catVoice.instruct ? { instruct: catVoice.instruct } : {}),
    ...(catVoice.temperature != null ? { temperature: catVoice.temperature } : {}),
  };
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

async function streamColdListenAsset(options: {
  request: FastifyRequest;
  reply: FastifyReply;
  provider: ITtsProvider;
  synthRequest: TtsSynthesizeRequest;
  cacheDir: string;
  hash: string;
}): Promise<void> {
  const controller = new AbortController();
  const abortOnClose = () => controller.abort(new Error('Listen client disconnected'));
  options.reply.raw.once('close', abortOnClose);
  try {
    const asset = await synthesizeAndCacheListenAsset({
      provider: options.provider,
      request: options.synthRequest,
      cacheDir: options.cacheDir,
      hash: options.hash,
      signal: controller.signal,
      onChunk: (event) => {
        if (options.reply.raw.destroyed || options.reply.raw.writableEnded) return;
        sendListenEvent(options.reply, {
          type: 'chunk',
          audioBase64: Buffer.from(event.audio).toString('base64'),
          format: event.format,
          durationSec: event.durationSec,
          isFinalChunk: event.isFinalChunk,
        });
      },
    });
    if (!options.reply.raw.destroyed && !options.reply.raw.writableEnded) sendListenEvent(options.reply, asset);
    options.request.log.info(
      {
        feature: 'F279',
        assetId: asset.assetId,
        cache_hit: false,
        cache_miss: true,
        cache_miss_reason: 'asset_not_found',
        synthesis_ms: asset.synthesisMs,
        ...(asset.durationSec && asset.durationSec > 0
          ? {
              duration_sec: asset.durationSec,
              tts_synthesis_rtf: (asset.synthesisMs ?? 0) / (asset.durationSec * 1000),
            }
          : {}),
      },
      '[F279] listen TTS stream asset',
    );
  } catch (error) {
    if (controller.signal.aborted) {
      options.request.log.info('[F279] listen TTS stream cancelled after client disconnect');
    } else {
      options.request.log.error({ err: error }, '[F279] listen TTS stream failed');
    }
    if (!controller.signal.aborted && !options.reply.raw.destroyed && !options.reply.raw.writableEnded) {
      sendListenEvent(options.reply, {
        type: 'error',
        error: error instanceof Error ? error.message : 'TTS stream failed',
      });
    }
  } finally {
    options.reply.raw.removeListener('close', abortOnClose);
    if (!options.reply.raw.destroyed && !options.reply.raw.writableEnded) options.reply.raw.end();
  }
}

async function handleListenStream(
  request: FastifyRequest<{ Body: unknown }>,
  reply: FastifyReply,
  options: Pick<TtsRouteOptions, 'ttsRegistry' | 'cacheDir'>,
): Promise<void> {
  if (!resolveUserId(request)) {
    await reply.status(401).send({ error: 'Identity required' });
    return;
  }
  const parsed = synthesizeSchema.safeParse(request.body);
  if (!parsed.success) {
    await reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  let provider: ITtsProvider;
  try {
    provider = options.ttsRegistry.getDefault();
  } catch {
    await reply.status(503).send({ error: 'No TTS provider available' });
    return;
  }

  const synthRequest = buildListenSynthesisRequest(parsed.data);
  const hash = synthesisHash(provider, synthRequest, LISTEN_AUDIO_CACHE_VERSION);
  startTtsEventStream(reply);
  const cachedAudio = await findCachedAudio(options.cacheDir, hash, 'wav');
  if (cachedAudio) {
    const assetId = path.basename(cachedAudio.filePath);
    sendListenEvent(reply, {
      type: 'asset',
      audioUrl: `/api/tts/audio/${assetId}`,
      assetId,
      cached: true,
      bytes: cachedAudio.bytes,
    });
    reply.raw.end();
    return;
  }
  await streamColdListenAsset({ request, reply, provider, synthRequest, cacheDir: options.cacheDir, hash });
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

    // Resolve voice config: explicit params > per-cat defaults
    const catVoice = catId ? getCatVoice(catId) : getCatVoice('opus');
    const voice = voiceOverride ?? catVoice.voice;
    const langCode = langCodeOverride ?? catVoice.langCode;
    const speed = speedOverride ?? catVoice.speed ?? 1.0;
    const requestedFormat = 'wav';
    // F066: Clone params from per-cat voice config
    const refAudio = catVoice.refAudio;
    const refText = catVoice.refText;
    const instruct = catVoice.instruct;
    const temperature = catVoice.temperature;

    // Get provider
    let provider: ITtsProvider;
    try {
      provider = ttsRegistry.getDefault();
    } catch {
      reply.status(503);
      return { error: 'No TTS provider available' };
    }

    const synthRequest: TtsSynthesizeRequest = {
      text,
      voice,
      langCode,
      speed,
      format: requestedFormat,
      ...(refAudio ? { refAudio } : {}),
      ...(refText ? { refText } : {}),
      ...(instruct ? { instruct } : {}),
      ...(temperature != null ? { temperature } : {}),
    };
    const hash = synthesisHash(provider, synthRequest);

    // First try cache with requested format, then try with alternate format
    let filePath: string | undefined;
    let cached = false;
    let durationSec: number | undefined;
    let synthesisMs = 0;
    const cachedAudio = await findCachedAudio(cacheDir, hash, requestedFormat);
    if (cachedAudio) {
      filePath = cachedAudio.filePath;
      cached = true;
    }

    if (!cached) {
      // Synthesize
      try {
        const synthesisStartedAt = Date.now();
        const result = await provider.synthesize(synthRequest);
        synthesisMs = Date.now() - synthesisStartedAt;
        durationSec = result.durationSec;
        // Double-check: only allow known audio extensions (defense in depth)
        const allowedFormats = new Set(['wav', 'mp3']);
        const actualFormat = allowedFormats.has(result.format) ? result.format : requestedFormat;
        const fname = `${hash}.${actualFormat}`;
        filePath = path.join(cacheDir, fname);
        await writeFile(filePath, result.audio);
      } catch (err) {
        request.log.error({ err, voice, langCode }, 'TTS synthesis failed');
        reply.status(502);
        return { error: 'TTS synthesis failed', detail: err instanceof Error ? err.message : 'unknown' };
      }
    }

    // filePath is always set: either from cache lookup or synthesis
    const resolvedFilename = path.basename(filePath ?? '');
    const resolvedStat = await fsStat(filePath ?? '');
    if (purpose === 'listen') {
      request.log.info(
        {
          feature: 'F279',
          assetId: resolvedFilename,
          cache_hit: cached,
          cache_miss: !cached,
          ...(!cached ? { cache_miss_reason: 'asset_not_found', synthesis_ms: synthesisMs } : {}),
          ...(durationSec != null && durationSec > 0
            ? { duration_sec: durationSec, tts_synthesis_rtf: synthesisMs / (durationSec * 1000) }
            : {}),
        },
        '[F279] listen TTS asset',
      );
    }
    return {
      audioUrl: `/api/tts/audio/${resolvedFilename}`,
      assetId: resolvedFilename,
      cached,
      bytes: resolvedStat.size,
      ...(durationSec != null ? { durationSec } : {}),
      ...(purpose === 'listen' ? { synthesisMs } : {}),
    };
  });

  app.post<{ Body: unknown }>('/api/tts/listen/stream', (request, reply) =>
    handleListenStream(request, reply, { ttsRegistry, cacheDir }),
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
      return { audioUrl: result.audioUrl, durationSec: result.durationSec };
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
    } catch {
      reply.status(503);
      return { error: 'No TTS provider available' };
    }

    const catVoice = getCatVoice(catId ?? 'opus');
    const voice = voiceOverride ?? catVoice.voice;
    const langCode = langCodeOverride ?? catVoice.langCode;
    const speed = speedOverride ?? catVoice.speed ?? 1.0;
    const refAudio = catVoice.refAudio;
    const refText = catVoice.refText;
    const instruct = catVoice.instruct;
    const temperature = catVoice.temperature;

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

    for (let i = 0; i < chunks.length; i++) {
      if (reply.raw.destroyed || reply.raw.writableEnded) {
        request.log.info({ index: i, total: chunks.length }, '[TTS-STREAM] client disconnected, aborting');
        return;
      }

      const chunk = chunks[i];
      try {
        const synthRequest: TtsSynthesizeRequest = {
          text: chunk.text,
          voice,
          langCode,
          speed,
          format: 'wav',
          ...(refAudio ? { refAudio } : {}),
          ...(refText ? { refText } : {}),
          ...(instruct ? { instruct } : {}),
          ...(temperature != null ? { temperature } : {}),
        };

        const chunkStart = Date.now();
        const result = await provider.synthesize(synthRequest);
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
        });
        successfulChunks++;
      } catch (err) {
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
      sendEvent({ type: 'done', total: successfulChunks });
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

  if (documentListenRepository) {
    registerTtsListenRoutes(app, { cacheDir, repository: documentListenRepository });
  }
}
