import type { TtsSynthesizeRequest, VoiceChunkEvent, VoiceConfig } from '@cat-cafe/shared';
import type { TtsRegistry } from './TtsRegistry.js';

interface Broadcaster {
  broadcastToRoom(room: string, event: string, data: unknown): void;
}

const HARD_BREAKS = new Set(['。', '？', '！', '.', '?', '!']);
const SOFT_BREAKS = new Set(['，', ',', '、', '：', ':', '；', ';']);

const BOOST_COUNT = 2;
const NORMAL_THRESHOLD = 4;
const BOOST_THRESHOLD = 2;

export interface StreamingTtsChunkerConfig {
  readonly catId: string;
  readonly invocationId: string;
  readonly threadId: string;
  readonly voiceConfig: VoiceConfig;
  readonly broadcaster: Broadcaster;
  readonly ttsRegistry: TtsRegistry;
  readonly signal?: AbortSignal;
}

export class StreamingTtsChunker {
  private buffer = '';
  private chunkIndex = 0;
  private readonly pendingSyntheses: Promise<void>[] = [];
  private aborted = false;
  private startBroadcasted = false;
  private readonly config: StreamingTtsChunkerConfig;

  constructor(config: StreamingTtsChunkerConfig) {
    this.config = config;
    config.signal?.addEventListener('abort', () => {
      this.aborted = true;
    });
  }

  feed(token: string): void {
    if (this.aborted) return;

    for (const ch of token) {
      if (ch === '\n') {
        this.flushBuffer();
        continue;
      }

      this.buffer += ch;

      if (HARD_BREAKS.has(ch)) {
        this.flushBuffer();
      } else if (SOFT_BREAKS.has(ch)) {
        const threshold = this.chunkIndex < BOOST_COUNT ? BOOST_THRESHOLD : NORMAL_THRESHOLD;
        if (this.buffer.length >= threshold) {
          this.flushBuffer();
        }
      }
    }
  }

  private flushBuffer(): void {
    const text = this.buffer.trim();
    this.buffer = '';
    if (!text || this.aborted) return;

    const index = this.chunkIndex++;
    const promise = this.synthesizeAndBroadcast(text, index);
    this.pendingSyntheses.push(promise);
  }

  private async synthesizeAndBroadcast(text: string, index: number): Promise<void> {
    if (this.aborted) return;

    const { catId, invocationId, threadId, voiceConfig, broadcaster, ttsRegistry } = this.config;

    let provider;
    try {
      provider = ttsRegistry.getDefault();
    } catch {
      console.error(`[StreamingTtsChunker] No TTS provider available`);
      return;
    }

    const synthRequest: TtsSynthesizeRequest = {
      text,
      voice: voiceConfig.voice,
      langCode: voiceConfig.langCode,
      speed: voiceConfig.speed ?? 1.0,
      format: 'wav',
      ...(voiceConfig.refAudio ? { refAudio: voiceConfig.refAudio } : {}),
      ...(voiceConfig.refText ? { refText: voiceConfig.refText } : {}),
      ...(voiceConfig.instruct ? { instruct: voiceConfig.instruct } : {}),
      ...(voiceConfig.temperature != null ? { temperature: voiceConfig.temperature } : {}),
    };

    try {
      const result = await provider.synthesize(synthRequest);
      if (this.aborted) return;

      const audioBase64 = Buffer.from(result.audio).toString('base64');

      const event: VoiceChunkEvent = {
        type: 'voice_chunk',
        catId,
        invocationId,
        threadId,
        index,
        audioBase64,
        text,
        format: result.format,
        durationSec: result.durationSec,
      };

      if (!this.startBroadcasted) {
        this.startBroadcasted = true;
        broadcaster.broadcastToRoom(`thread:${threadId}`, 'voice_stream_start', {
          type: 'voice_stream_start',
          catId,
          invocationId,
          threadId,
        });
        console.log(`[StreamingTtsChunker] First chunk sent for ${catId} inv=${invocationId}`);
      }

      broadcaster.broadcastToRoom(`thread:${threadId}`, 'voice_chunk', event);
    } catch (err) {
      console.error(`[StreamingTtsChunker] Synthesis failed for chunk ${index}:`, err);
    }
  }

  async flush(): Promise<number> {
    this.flushBuffer();
    await Promise.allSettled(this.pendingSyntheses);
    return this.chunkIndex;
  }

  abort(): void {
    this.aborted = true;
  }

  getChunkCount(): number {
    return this.chunkIndex;
  }

  hasStarted(): boolean {
    return this.startBroadcasted;
  }
}

let ttsRegistryInstance: TtsRegistry | null = null;

export function initStreamingTtsRegistry(registry: TtsRegistry): void {
  ttsRegistryInstance = registry;
}

export function getStreamingTtsRegistry(): TtsRegistry | null {
  return ttsRegistryInstance;
}
