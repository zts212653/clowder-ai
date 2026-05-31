import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ISttProvider, SttTranscribeRequest, SttTranscribeResult } from '@cat-cafe/shared';
import { normalizeLoopbackUrl } from '../../../domains/services/loopback-url.js';
import { getServiceConfig } from '../../../domains/services/service-config.js';
import { getServiceManifest, resolveServiceEndpoint } from '../../../domains/services/service-manifest.js';

export interface WhisperSttProviderOptions {
  baseUrl?: string;
  model?: string;
  /** @internal test injection */
  _fetchFn?: typeof fetch;
}

function resolveWhisperBaseUrl(): string {
  const service = getServiceManifest('whisper-stt');
  if (!service) return process.env.WHISPER_URL ?? 'http://127.0.0.1:9876';
  return resolveServiceEndpoint(service, process.env, getServiceConfig('whisper-stt')) ?? 'http://127.0.0.1:9876';
}

export class WhisperSttProvider implements ISttProvider {
  readonly id = 'whisper-local';
  readonly model: string;
  // Caller-supplied baseUrl is treated as an explicit override (mostly
  // tests). When omitted, resolve on every transcribe so /reconfigure-driven
  // port changes flow into the next request without restarting the API
  // (codex P1 2026-05-25, outdated thread).
  private readonly baseUrlOverride: string | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(opts?: WhisperSttProviderOptions) {
    this.baseUrlOverride = opts?.baseUrl ? normalizeLoopbackUrl(opts.baseUrl) : undefined;
    this.model = opts?.model ?? 'whisper-large-v3';
    this.fetchFn = opts?._fetchFn ?? fetch;
  }

  private resolveBaseUrl(): string {
    return this.baseUrlOverride ?? normalizeLoopbackUrl(resolveWhisperBaseUrl());
  }

  async transcribe(request: SttTranscribeRequest): Promise<SttTranscribeResult> {
    const audioBuffer = await readFile(request.audioPath);
    const ext = path.extname(request.audioPath).slice(1) || 'wav';
    const mimeType = ext === 'mp3' ? 'audio/mpeg' : ext === 'ogg' ? 'audio/ogg' : `audio/${ext}`;

    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: mimeType }), `audio.${ext}`);
    formData.append('model', this.model);
    if (request.language) formData.append('language', request.language);

    const response = await this.fetchFn(`${this.resolveBaseUrl()}/v1/audio/transcriptions`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`STT request failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as { text: string; duration?: number };

    return {
      text: data.text,
      ...(data.duration !== undefined ? { durationSec: data.duration } : {}),
      metadata: { provider: this.id, model: this.model },
    };
  }
}
