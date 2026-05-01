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
import type { TtsStreamEvent, TtsSynthesizeRequest } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { getCatVoice } from '../config/cat-voices.js';
import { chunkText } from '../domains/cats/services/tts/TtsChunker.js';
import type { TtsRegistry } from '../domains/cats/services/tts/TtsRegistry.js';
import { getVoiceBlockSynthesizer } from '../domains/cats/services/tts/VoiceBlockSynthesizer.js';
import { resolveUserId } from '../utils/request-identity.js';

const synthesizeSchema = z.object({
  text: z.string().min(1).max(20000),
  catId: z.string().optional(),
  voice: z.string().optional(),
  langCode: z.string().optional(),
  speed: z.number().min(0.5).max(2.0).optional(),
});

/** Strict validation for audio download filename: {64-hex}.{wav|mp3} */
const AUDIO_FILENAME_RE = /^[0-9a-f]{64}\.(wav|mp3)$/;

export interface TtsRouteOptions extends FastifyPluginOptions {
  ttsRegistry: TtsRegistry;
  cacheDir: string;
}

export async function ttsRoutes(app: FastifyInstance, opts: TtsRouteOptions): Promise<void> {
  const { ttsRegistry, cacheDir } = opts;

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
    const { text, catId, voice: voiceOverride, langCode: langCodeOverride, speed: speedOverride } = parsed.data;

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
    let provider;
    try {
      provider = ttsRegistry.getDefault();
    } catch {
      reply.status(503);
      return { error: 'No TTS provider available' };
    }

    // Compute cache hash: includes clone params so different voices get distinct cache entries
    const hashParts = [provider.id, provider.model, voice, langCode, String(speed), requestedFormat, text];
    if (refAudio) hashParts.push(refAudio);
    if (refText) hashParts.push(refText);
    if (instruct) hashParts.push(instruct);
    if (temperature != null) hashParts.push(String(temperature));
    const hashInput = hashParts.join('|');
    const hash = createHash('sha256').update(hashInput).digest('hex');

    // First try cache with requested format, then try with alternate format
    let filePath: string | undefined;
    let cached = false;
    for (const ext of [requestedFormat, requestedFormat === 'wav' ? 'mp3' : 'wav']) {
      const candidatePath = path.join(cacheDir, `${hash}.${ext}`);
      try {
        await fsStat(candidatePath);
        filePath = candidatePath;
        cached = true;
        break;
      } catch {
        // Not cached with this extension
      }
    }

    if (!cached) {
      // Synthesize
      try {
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
        const result = await provider.synthesize(synthRequest);
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
    return {
      audioUrl: `/api/tts/audio/${resolvedFilename}`,
    };
  });

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

    let provider;
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

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

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
}
