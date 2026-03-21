/**
 * F34-b: Voice Block Synthesizer
 *
 * Singleton service that resolves audio rich blocks with `text` but no `url`
 * by calling the TTS provider and writing the audio to disk.
 *
 * Used by:
 * - route-serial.ts (Route B: text-extracted rich blocks)
 * - callbacks.ts (Route A: MCP-buffered rich blocks)
 */

import { createHash } from 'node:crypto';
import { stat as fsStat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RichBlock } from '@cat-cafe/shared';
import { getCatVoice } from '../../../../config/cat-voices.js';
import { createModuleLogger } from '../../../../infrastructure/logger.js';
import type { TtsRegistry } from './TtsRegistry.js';

const log = createModuleLogger('voice-synthesizer');

let instance: VoiceBlockSynthesizer | null = null;

export function initVoiceBlockSynthesizer(ttsRegistry: TtsRegistry, cacheDir: string): void {
  instance = new VoiceBlockSynthesizer(ttsRegistry, cacheDir);
}

export function getVoiceBlockSynthesizer(): VoiceBlockSynthesizer | null {
  return instance;
}

// ---------------------------------------------------------------------------
// F066 Phase 4: Error classification + retry helpers
// ---------------------------------------------------------------------------

/**
 * Extract the effective error code and message, unwrapping `err.cause` for
 * Node `fetch` errors where the real info (e.g. ECONNREFUSED) lives on cause.
 */
function extractErrorInfo(err: Error): { code: string | undefined; msg: string } {
  const code = (err as NodeJS.ErrnoException).code;
  const cause = (err as { cause?: Error }).cause;
  const causeCode = cause instanceof Error ? (cause as NodeJS.ErrnoException).code : undefined;
  const causeMsg = cause instanceof Error ? cause.message : '';
  return {
    code: code ?? causeCode,
    msg: `${err.message} ${causeMsg}`.trim(),
  };
}

/** Classify an error into a user-friendly category for the 🔇 card. */
function classifyError(err: unknown): string {
  if (!(err instanceof Error)) return '未知错误';
  const { code, msg } = extractErrorInfo(err);

  if (code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED')) return '连接被拒绝';
  if (code === 'ETIMEDOUT' || err.name === 'AbortError' || msg.includes('ETIMEDOUT') || msg.includes('timed out'))
    return '合成超时';
  if (/returned\s+5\d{2}/.test(msg)) return '服务错误';
  if (/returned\s+4\d{2}/.test(msg)) return '请求错误';
  return '未知错误';
}

/** Determine if an error is transient and worth retrying. */
function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const { code, msg } = extractErrorInfo(err);

  // Network-level transient errors (top-level or cause)
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ECONNRESET') return true;
  // Abort (timeout)
  if (err.name === 'AbortError') return true;
  // HTTP 5xx
  if (/returned\s+5\d{2}/.test(msg)) return true;

  return false;
}

const RETRY_DELAY_MS = 2_000;

export class VoiceBlockSynthesizer {
  constructor(
    private readonly ttsRegistry: TtsRegistry,
    private readonly cacheDir: string,
  ) {}

  /**
   * Process an array of rich blocks. For audio blocks with `text` but no/empty `url`,
   * synthesize via TTS and fill in the url + durationSec.
   *
   * Blocks that fail synthesis are converted to info cards (graceful degradation).
   * Non-audio blocks pass through unchanged.
   */
  async resolveVoiceBlocks(blocks: RichBlock[], catId: string): Promise<RichBlock[]> {
    const resolved: RichBlock[] = [];

    for (const block of blocks) {
      if (block.kind !== 'audio') {
        resolved.push(block);
        continue;
      }

      // Voice blocks from cats may have `text` but no `url` (runtime shape differs from strict type)
      const text = 'text' in block && typeof block.text === 'string' ? block.text.trim() : '';
      const existingUrl = 'url' in block && typeof block.url === 'string' ? block.url.trim() : '';

      // Only synthesize if text is present and url is missing/empty
      if (!text || existingUrl) {
        resolved.push(block);
        continue;
      }

      // F085-P3: per-block speaker override for multi-cat voice
      const voiceCatId = 'speaker' in block && typeof block.speaker === 'string' ? block.speaker : catId;

      try {
        const result = await this.synthesizeWithRetry(text, voiceCatId);
        resolved.push({
          ...block,
          url: result.audioUrl,
          ...(result.durationSec != null ? { durationSec: result.durationSec } : {}),
          mimeType: 'audio/wav',
        });
      } catch (err) {
        // F066 Phase 4: Classify the error for user-friendly display
        const errorCategory = classifyError(err);
        log.error({ catId, error: err }, 'Synthesis failed');
        resolved.push({
          id: block.id,
          kind: 'card' as const,
          v: 1 as const,
          title: '🔇 语音合成失败',
          bodyMarkdown: `${text}\n\n---\n⚠️ 错误类型：${errorCategory}`,
          tone: 'warning' as const,
          actions: [
            {
              label: '重新合成',
              action: 'tts-resynthesize',
              payload: { text, catId: voiceCatId },
            },
          ],
        });
      }
    }

    return resolved;
  }

  /**
   * F066 Phase 4: Public method for resynthesize endpoint.
   * Re-attempts TTS synthesis with retry for a given text + catId.
   */
  async resynthesize(text: string, catId: string): Promise<{ audioUrl: string; durationSec?: number }> {
    return this.synthesizeWithRetry(text, catId);
  }

  /**
   * F066 Phase 4: Synthesize with 1 automatic retry for transient errors.
   */
  private async synthesizeWithRetry(text: string, catId: string): Promise<{ audioUrl: string; durationSec?: number }> {
    try {
      return await this.synthesizeToFile(text, catId);
    } catch (err) {
      if (!isRetryableError(err)) throw err;

      log.warn({ retryDelayMs: RETRY_DELAY_MS, error: err }, 'Transient error, retrying');
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      return await this.synthesizeToFile(text, catId);
    }
  }

  /**
   * Synthesize text to an audio file and return the URL path.
   */
  private async synthesizeToFile(text: string, catId: string): Promise<{ audioUrl: string; durationSec?: number }> {
    await mkdir(this.cacheDir, { recursive: true });

    let provider;
    try {
      provider = this.ttsRegistry.getDefault();
    } catch {
      throw new Error('No TTS provider available');
    }

    // Resolve per-cat voice
    const catVoice = getCatVoice(catId);
    const voice = catVoice.voice;
    const langCode = catVoice.langCode;
    const speed = catVoice.speed ?? 1.0;
    const format = 'wav' as const;

    // F066: Clone fields from E-type voice config
    const refAudio = catVoice.refAudio;
    const refText = catVoice.refText;
    const instruct = catVoice.instruct;
    const temperature = catVoice.temperature;

    // Cache hash — includes clone params for distinct cache entries per voice config
    const hashParts = [provider.id, provider.model, voice, langCode, String(speed), format, text];
    if (refAudio) hashParts.push(refAudio);
    if (refText) hashParts.push(refText);
    if (instruct) hashParts.push(instruct);
    if (temperature != null) hashParts.push(String(temperature));
    const hashInput = hashParts.join('|');
    const hash = createHash('sha256').update(hashInput).digest('hex');
    const filename = `${hash}.${format}`;
    const filePath = path.join(this.cacheDir, filename);

    // Check cache
    let cached = false;
    try {
      await fsStat(filePath);
      cached = true;
    } catch {
      /* not cached */
    }

    if (!cached) {
      const result = await provider.synthesize({
        text,
        voice,
        langCode,
        speed,
        format,
        ...(refAudio ? { refAudio } : {}),
        ...(refText ? { refText } : {}),
        ...(instruct ? { instruct } : {}),
        ...(temperature != null ? { temperature } : {}),
      });
      await writeFile(filePath, result.audio);
    }

    return { audioUrl: `/api/tts/audio/${filename}` };
  }
}
