import type { CatVoiceResolution, ITtsProvider, TtsVoiceSelection, VoiceChunkEvent } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../infrastructure/logger.js';
import {
  completeVoiceSelection,
  prepareResolvedCatVoice,
  ReferenceAudioChangedError,
  VoiceSelectionSequence,
} from './cat-voice-synthesis.js';
import type { TtsRegistry } from './TtsRegistry.js';

const log = createModuleLogger('streaming-tts');

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
  readonly voiceResolution: CatVoiceResolution;
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
  private referenceSequence = Promise.resolve();
  private completedSelection?: TtsVoiceSelection;
  private readonly selections = new VoiceSelectionSequence();
  private sentChunks = 0;
  private readonly config: StreamingTtsChunkerConfig;
  private preparation?: Promise<{ provider: ITtsProvider; voice: ReturnType<typeof prepareResolvedCatVoice> }>;

  constructor(config: StreamingTtsChunkerConfig) {
    this.config = config;
    config.signal?.addEventListener('abort', () => {
      this.aborted = true;
    });
  }

  private prepareSynthesis() {
    this.preparation ??= (async () => {
      const selected = this.config.ttsRegistry.getDefault();
      const provider = (await selected.snapshot?.()) ?? selected;
      return { provider, voice: prepareResolvedCatVoice(this.config.voiceResolution, provider) };
    })();
    return this.preparation;
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
    // A reader-only path can change between requests. Observe each receipt
    // before another reference chunk starts; inline input is also kept once/turn.
    const promise = this.config.voiceResolution.config.refAudio
      ? this.referenceSequence.then(() => this.synthesizeAndBroadcast(text, index))
      : this.synthesizeAndBroadcast(text, index);
    if (this.config.voiceResolution.config.refAudio) this.referenceSequence = promise;
    this.pendingSyntheses.push(promise);
  }

  private async synthesizeAndBroadcast(text: string, index: number): Promise<void> {
    if (this.aborted) return;

    const { catId, invocationId, threadId, broadcaster } = this.config;

    try {
      const { provider, voice } = await this.prepareSynthesis();
      if (this.aborted) return;
      const result = await provider.synthesize({ ...voice.request, text });
      const voiceSelection = completeVoiceSelection(voice.voiceSelection, result.referenceAudio, provider);
      if (this.aborted) return;
      this.completedSelection = this.selections.observe(voiceSelection);

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
        voiceSelection,
      };

      if (!this.startBroadcasted) {
        this.startBroadcasted = true;
        broadcaster.broadcastToRoom(`thread:${threadId}`, 'voice_stream_start', {
          type: 'voice_stream_start',
          catId,
          invocationId,
          threadId,
          voiceSelection,
        });
        log.info({ catId, invocationId }, 'First chunk sent');
      }

      broadcaster.broadcastToRoom(`thread:${threadId}`, 'voice_chunk', event);
      this.sentChunks++;
    } catch (err) {
      if (err instanceof ReferenceAudioChangedError) {
        this.aborted = true;
        broadcaster.broadcastToRoom(`thread:${threadId}`, 'voice_stream_end', {
          type: 'voice_stream_end',
          catId,
          invocationId,
          threadId,
          totalChunks: this.sentChunks,
          voiceSelection: this.completedSelection && {
            ...this.completedSelection,
            referenceStatus: 'unverified',
            warnings: [...this.completedSelection.warnings, err.message],
          },
        });
      }
      log.error({ index, error: err }, 'Synthesis failed for chunk');
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
