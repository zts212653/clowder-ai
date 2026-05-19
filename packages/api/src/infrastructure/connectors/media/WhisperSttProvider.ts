import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ISttProvider, SttTranscribeRequest, SttTranscribeResult } from '@cat-cafe/shared';

export interface WhisperSttProviderOptions {
  baseUrl?: string;
  model?: string;
  /** @internal test injection */
  _fetchFn?: typeof fetch;
}

export class WhisperSttProvider implements ISttProvider {
  readonly id = 'whisper-local';
  readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts?: WhisperSttProviderOptions) {
    this.baseUrl = opts?.baseUrl ?? process.env.WHISPER_URL ?? 'http://localhost:9876';
    this.model = opts?.model ?? 'whisper-large-v3';
    this.fetchFn = opts?._fetchFn ?? fetch;
  }

  async transcribe(request: SttTranscribeRequest): Promise<SttTranscribeResult> {
    const audioBuffer = await readFile(request.audioPath);
    const ext = path.extname(request.audioPath).slice(1) || 'wav';
    const mimeType = ext === 'mp3' ? 'audio/mpeg' : ext === 'ogg' ? 'audio/ogg' : `audio/${ext}`;

    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: mimeType }), `audio.${ext}`);
    formData.append('model', this.model);
    if (request.language) formData.append('language', request.language);

    const response = await this.fetchFn(`${this.baseUrl}/v1/audio/transcriptions`, {
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
