import { createHash } from 'node:crypto';
import { rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ITtsProvider,
  TtsSynthesizeRequest,
  TtsSynthesizeResult,
  TtsSynthesizeStreamEvent,
  TtsVoiceSelection,
} from '@cat-cafe/shared';
import { cachedVoiceSelection, completeVoiceSelection, prepareCatVoice } from './cat-voice-synthesis.js';
import { LISTEN_AUDIO_CACHE_VERSION, pcm16WavDurationSec, trimLeadingPcm16Wav } from './listen-audio-postprocess.js';
import { independentAudioHash, referenceAudioCacheIdentity } from './reference-audio-cache.js';
import type { TtsRegistry } from './TtsRegistry.js';
import { inspectAudioFileSync } from './tts-asset-cleanup.js';
import { canReuseVoiceAsset, writeAssetVoiceReceipt } from './tts-asset-provenance.js';

const AUDIO_FORMATS = ['wav', 'mp3'] as const;

export interface ListenSynthesisOptions {
  catId?: string;
  voice?: string;
  langCode?: string;
  speed?: number;
}

export interface ListenAsset {
  audioUrl: string;
  assetId: string;
  cached: boolean;
  bytes: number;
  synthesisFingerprint: string;
  durationSec?: number;
  synthesisMs?: number;
  voiceSelection?: TtsVoiceSelection;
  reusable?: boolean;
}

export interface GetOrCreateListenAssetOptions {
  /** Internal document jobs keep one prepared model/endpoint for every sentence. */
  preparedSynthesis?: PreparedListenSynthesis;
  synthesis?: ListenSynthesisOptions;
  signal?: AbortSignal;
  onChunk?: (event: Extract<TtsSynthesizeStreamEvent, { type: 'chunk' }>) => void;
}

export interface PreparedListenSynthesis {
  provider: ITtsProvider;
  request: Omit<TtsSynthesizeRequest, 'text'>;
  fingerprint: string;
  voiceSelection: TtsVoiceSelection;
  /** Pre-receipt document identity, for retaining existing recorded assets. */
  legacyFingerprint?: string;
}

interface InFlightAsset {
  controller: AbortController;
  consumers: number;
  listeners: Set<NonNullable<GetOrCreateListenAssetOptions['onChunk']>>;
  promise: Promise<ListenAsset>;
}

function synthesisHash(
  provider: Pick<ITtsProvider, 'id' | 'model' | 'cacheIdentity'>,
  request: TtsSynthesizeRequest,
  variant?: string,
  documentIdentity = false,
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
  if (request.refAudio) {
    parts.push(request.refAudio);
    if (!documentIdentity || request.refAudioData)
      parts.push(referenceAudioCacheIdentity(request.refAudio, request.refAudioData?.sha256));
  }
  if (request.refText) parts.push(request.refText);
  if (request.instruct) parts.push(request.instruct);
  if (request.temperature != null) parts.push(String(request.temperature));
  const baseHash = createHash('sha256')
    .update(request.refAudioData ? JSON.stringify(parts) : parts.join('|'))
    .digest('hex');
  return variant ? createHash('sha256').update(`${baseHash}\0variant:${variant}`).digest('hex') : baseHash;
}

function fingerprintFor(provider: ITtsProvider, request: Omit<TtsSynthesizeRequest, 'text'>): string {
  return synthesisHash(provider, { ...request, text: '' }, LISTEN_AUDIO_CACHE_VERSION, true);
}

async function findCachedAudio(cacheDir: string, hash: string): Promise<{ assetId: string; bytes: number } | null> {
  for (const extension of ['wav', 'mp3'] as const) {
    const assetId = `${hash}.${extension}`;
    try {
      const fileStat = await stat(path.join(cacheDir, assetId));
      if (fileStat.isFile()) return { assetId, bytes: fileStat.size };
    } catch {
      // Try the alternate supported format.
    }
  }
  return null;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Listen asset request aborted');
}

/**
 * The one server-side path that turns a listen sentence into a content-addressed
 * asset. Playback and document-cache runs share both its hash and in-flight work.
 */
export class ListenAssetService {
  private readonly inFlight = new Map<string, InFlightAsset>();
  private readonly pendingPublications = new Set<Promise<unknown>>();
  private closing = false;

  constructor(
    private readonly registry: TtsRegistry,
    private readonly cacheDir: string,
  ) {}

  async getSynthesisFingerprint(options?: ListenSynthesisOptions): Promise<string> {
    return (await this.prepareSynthesis(options)).fingerprint;
  }

  async getOrCreate(text: string, options: GetOrCreateListenAssetOptions = {}): Promise<ListenAsset> {
    if (this.closing) throw new Error('Listen asset service is closing');
    options.signal?.throwIfAborted();
    const synthesis = options.preparedSynthesis ?? (await this.prepareSynthesis(options.synthesis));
    const request = { ...synthesis.request, text };
    const hash = synthesisHash(synthesis.provider, request, LISTEN_AUDIO_CACHE_VERSION);
    const found = !request.refAudio || request.refAudioData ? await findCachedAudio(this.cacheDir, hash) : null;
    const cached =
      found && (await canReuseVoiceAsset(this.cacheDir, found.assetId, synthesis.voiceSelection)) ? found : null;
    // Cache probing yields to I/O. A disconnect in that window must return to
    // the caller before it can create an otherwise unowned producer.
    options.signal?.throwIfAborted();
    if (cached) {
      if (!request.refAudio)
        await writeAssetVoiceReceipt(this.cacheDir, cached.assetId, synthesis.voiceSelection, true);
      return {
        audioUrl: `/api/tts/audio/${cached.assetId}`,
        assetId: cached.assetId,
        cached: true,
        bytes: cached.bytes,
        synthesisFingerprint: synthesis.fingerprint,
        voiceSelection: cachedVoiceSelection(synthesis.voiceSelection),
        reusable: true,
      };
    }

    let flight = this.inFlight.get(hash);
    if (!flight || flight.controller.signal.aborted) {
      flight = this.createFlight(hash, synthesis, request);
      this.inFlight.set(hash, flight);
    }
    if (options.onChunk) flight.listeners.add(options.onChunk);
    try {
      // A shared audio flight can serve different members; provenance belongs to this caller.
      const asset = await this.waitForFlight(flight, options.signal);
      const actual = asset.voiceSelection;
      const receipt: TtsSynthesizeResult['referenceAudio'] =
        actual?.referenceStatus === 'unavailable'
          ? { status: 'unavailable' }
          : actual?.referenceSha256
            ? { status: 'used', sha256: actual.referenceSha256 }
            : { status: 'unverified' };
      return {
        ...asset,
        voiceSelection: completeVoiceSelection(synthesis.voiceSelection, receipt, synthesis.provider),
      };
    } finally {
      if (options.onChunk) flight.listeners.delete(options.onChunk);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const flight of this.inFlight.values()) {
      flight.controller.abort(new Error('Listen asset service closed'));
    }
    await Promise.allSettled([...this.pendingPublications]);
  }

  isAssetAvailable(assetId: string): boolean {
    return (
      /^[a-f0-9]{64}\.(wav|mp3)$/.test(assetId) &&
      typeof inspectAudioFileSync(path.join(this.cacheDir, assetId)) !== 'string'
    );
  }

  async prepareSynthesis(options: ListenSynthesisOptions = {}): Promise<PreparedListenSynthesis> {
    const selected = this.registry.getDefault();
    const provider = (await selected.snapshot?.({ cacheDir: this.cacheDir })) ?? selected;
    const { request, voiceSelection } = prepareCatVoice(
      options.catId ?? 'opus',
      provider,
      {
        ...(options.voice !== undefined ? { voice: options.voice } : {}),
        ...(options.langCode !== undefined ? { langCode: options.langCode } : {}),
        ...(options.speed !== undefined ? { speed: options.speed } : {}),
      },
      this.cacheDir,
    );
    return {
      provider,
      request,
      voiceSelection,
      fingerprint: fingerprintFor(provider, request),
      legacyFingerprint: fingerprintFor(provider, { ...voiceSelection.requested, format: 'wav' }),
    };
  }

  private createFlight(hash: string, synthesis: PreparedListenSynthesis, request: TtsSynthesizeRequest): InFlightAsset {
    const controller = new AbortController();
    const flight: InFlightAsset = {
      controller,
      consumers: 0,
      listeners: new Set(),
      promise: Promise.resolve({} as ListenAsset),
    };
    flight.promise = this.synthesize(hash, synthesis, request, flight).finally(() => {
      if (this.inFlight.get(hash) === flight) this.inFlight.delete(hash);
    });
    // A pre-consumer disconnect can reject the producer before waitForFlight
    // attaches its usual observer. Keep the shared producer rejection observed
    // even when no caller remains to await it.
    void flight.promise.catch(() => undefined);
    return flight;
  }

  private async synthesize(
    hash: string,
    synthesis: PreparedListenSynthesis,
    request: TtsSynthesizeRequest,
    flight: InFlightAsset,
  ): Promise<ListenAsset> {
    const startedAt = Date.now();
    const result = await this.requestSynthesis(synthesis, request, flight);
    const voiceSelection = completeVoiceSelection(synthesis.voiceSelection, result.referenceAudio, synthesis.provider);
    flight.controller.signal.throwIfAborted();
    const asset = await this.trackPublication(
      (async () => {
        const published = await this.publishAsset(
          request.refAudioData && voiceSelection.referenceStatus !== 'sent' ? independentAudioHash(hash) : hash,
          result,
          flight.controller.signal,
        );
        await writeAssetVoiceReceipt(
          this.cacheDir,
          published.assetId,
          voiceSelection,
          !request.refAudio || voiceSelection.referenceStatus === 'sent',
        );
        return published;
      })(),
    );
    return {
      ...asset,
      voiceSelection,
      reusable: !request.refAudio || voiceSelection.referenceStatus === 'sent',
      cached: false,
      synthesisFingerprint: synthesis.fingerprint,
      synthesisMs: Date.now() - startedAt,
    };
  }

  private async requestSynthesis(
    synthesis: PreparedListenSynthesis,
    request: TtsSynthesizeRequest,
    flight: InFlightAsset,
  ): Promise<TtsSynthesizeResult> {
    if (!synthesis.provider.stream) return synthesis.provider.synthesize(request);
    let result: TtsSynthesizeResult | undefined;
    for await (const event of synthesis.provider.stream(request, { signal: flight.controller.signal })) {
      if (event.type === 'chunk')
        this.notifyChunkListeners(flight, {
          ...event,
          voiceSelection: completeVoiceSelection(synthesis.voiceSelection, event.referenceAudio, synthesis.provider),
        });
      else result = event.result;
    }
    if (!result) throw new Error('TTS stream completed without a final cache asset');
    return result;
  }

  private notifyChunkListeners(
    flight: InFlightAsset,
    event: Extract<TtsSynthesizeStreamEvent, { type: 'chunk' }>,
  ): void {
    for (const listener of flight.listeners) {
      try {
        listener(event);
      } catch {
        // A disconnected SSE observer must not poison the shared asset.
      }
    }
  }

  private async publishAsset(
    hash: string,
    result: TtsSynthesizeResult,
    signal: AbortSignal,
  ): Promise<Omit<ListenAsset, 'cached' | 'synthesisFingerprint' | 'synthesisMs'>> {
    if (this.closing) throw new Error('Listen asset service is closing');
    signal.throwIfAborted();
    const format = AUDIO_FORMATS.includes(result.format as (typeof AUDIO_FORMATS)[number]) ? result.format : 'wav';
    const audio = format === 'wav' ? trimLeadingPcm16Wav(result.audio) : result.audio;
    const durationSec = format === 'wav' ? (pcm16WavDurationSec(audio) ?? result.durationSec) : result.durationSec;
    const assetId = `${hash}.${format}`;
    const assetPath = path.join(this.cacheDir, assetId);
    const temporaryPath = path.join(this.cacheDir, `.${assetId}.${process.pid}.${Date.now()}.tmp`);
    try {
      // Readers only discover the final filename, so a cache probe can never
      // observe an incomplete WAV while the shared producer is flushing it.
      await writeFile(temporaryPath, audio);
      await rename(temporaryPath, assetPath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
    return {
      audioUrl: `/api/tts/audio/${assetId}`,
      assetId,
      bytes: audio.byteLength,
      ...(durationSec != null ? { durationSec } : {}),
    };
  }

  private async trackPublication<T>(publication: Promise<T>): Promise<T> {
    this.pendingPublications.add(publication);
    try {
      return await publication;
    } finally {
      this.pendingPublications.delete(publication);
    }
  }

  private async waitForFlight(flight: InFlightAsset, signal?: AbortSignal): Promise<ListenAsset> {
    flight.consumers++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      flight.consumers--;
      if (flight.consumers === 0 && !flight.controller.signal.aborted) flight.controller.abort();
    };
    if (!signal) return flight.promise.finally(release);
    if (signal.aborted) {
      release();
      throw abortError(signal);
    }
    return new Promise<ListenAsset>((resolve, reject) => {
      const abort = () => {
        release();
        reject(abortError(signal));
      };
      signal.addEventListener('abort', abort, { once: true });
      void flight.promise.then(
        (asset) => {
          signal.removeEventListener('abort', abort);
          release();
          resolve(asset);
        },
        (error) => {
          signal.removeEventListener('abort', abort);
          release();
          reject(error);
        },
      );
    });
  }
}
