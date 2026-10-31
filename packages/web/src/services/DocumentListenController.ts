'use client';

import type { ListenDocumentState, ListenPlaybackRate, ListenRetention } from '@cat-cafe/shared';
import type { ListenDocumentDescriptor, ListenModeSession } from '@/stores/listenModeStore';
import { listenDocumentCacheKey, useListenModeStore } from '@/stores/listenModeStore';
import { useVoiceSessionStore } from '@/stores/voiceSessionStore';
import { apiFetch } from '@/utils/api-client';
import { type ListenModeApi, type ListenSynthesisEvent, listenModeApi } from './listenModeApi';
import type { PlaybackManager, PlaybackSnapshot } from './PlaybackManager';
import { getPlaybackManager } from './playbackRuntime';

const PREFETCH_AHEAD = 4;

export interface ListenModeHealthMetric {
  feature: 'F279';
  metric: 'first_segment_ready_ms' | 'first_audio_play_ms' | 'prefetch_buffer_segments' | 'buffer_underrun_count';
  contentDigest: string;
  value: number;
}

interface ControllerDependencies {
  api: ListenModeApi;
  getManager: () => PlaybackManager;
  fetchAudio: typeof apiFetch;
  now: () => number;
  telemetry: (event: ListenModeHealthMetric) => void;
}

const defaultDependencies: ControllerDependencies = {
  api: listenModeApi,
  getManager: getPlaybackManager,
  fetchAudio: apiFetch,
  now: Date.now,
  telemetry: (event) => console.info('[F279] listen health', event),
};

function documentState(session: ListenModeSession, now: number): ListenDocumentState {
  return {
    identity: session.identity,
    sentences: session.sentences.map(({ anchor }) => ({ anchor })),
    position: {
      anchor: session.sentences[session.currentIndex]?.anchor ?? null,
      offsetSeconds: session.currentTime,
    },
    playbackRate: session.playbackRate,
    retention: session.retention,
    updatedAt: now,
  };
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, Math.max(0, length - 1)));
}

function restoredSession(
  descriptor: ListenDocumentDescriptor,
  saved: Awaited<ReturnType<ListenModeApi['load']>>,
  explicitIndex?: number,
): Partial<ListenModeSession> {
  const savedIndex = saved?.position.anchor
    ? descriptor.sentences.findIndex(({ anchor }) => anchor === saved.position.anchor)
    : -1;
  const currentIndex = clampIndex(explicitIndex ?? (savedIndex >= 0 ? savedIndex : 0), descriptor.sentences.length);
  return {
    currentIndex,
    currentTime: explicitIndex == null ? (saved?.position.offsetSeconds ?? 0) : 0,
    playbackRate: saved?.playbackRate ?? 1,
    retention: saved?.retention ?? '7d',
    cachedAnchors: saved?.sentences.filter(({ assetId }) => assetId).map(({ anchor }) => anchor) ?? [],
    cacheBytes: saved?.cache?.totalBytes ?? 0,
  };
}

export class DocumentListenController {
  private generation = 0;
  private descriptor: ListenDocumentDescriptor | null = null;
  private startIndex = 0;
  private nextToPrepare = 0;
  private desiredEnd = -1;
  private pumpingGeneration: number | null = null;
  private preparedCount = 0;
  private resumeOffset = 0;
  private lastProgressKey = '';
  private persistTail: Promise<void> = Promise.resolve();
  private unsubscribeSnapshot: (() => void) | null = null;
  private unsubscribeItemEnd: (() => void) | null = null;
  private sessionStartedAt = 0;
  private firstSegmentReady = false;
  private firstAudioPlayed = false;
  private underrunActive = false;
  private underrunCount = 0;
  private synthesisAbort: AbortController | null = null;

  constructor(private readonly dependencies: ControllerDependencies = defaultDependencies) {}

  async startDocument(descriptor: ListenDocumentDescriptor, explicitIndex?: number): Promise<void> {
    if (descriptor.sentences.length === 0) return;
    const generation = ++this.generation;
    this.abortSynthesis();
    this.detachManagerListeners();
    this.descriptor = descriptor;
    this.sessionStartedAt = this.dependencies.now();
    this.firstSegmentReady = false;
    this.firstAudioPlayed = false;
    this.underrunActive = false;
    this.underrunCount = 0;

    useListenModeStore.setState({
      session: {
        ...descriptor,
        phase: 'loading',
        currentIndex: clampIndex(explicitIndex ?? 0, descriptor.sentences.length),
        currentTime: 0,
        duration: 0,
        playbackRate: 1,
        retention: '7d',
        cachedAnchors: [],
        cacheBytes: 0,
        error: null,
      },
    });

    try {
      const saved = await this.dependencies.api.load(descriptor.identity);
      if (generation !== this.generation) return;
      const restored = restoredSession(descriptor, saved, explicitIndex);
      this.updateSession(restored);
      await this.persist();
      if (generation !== this.generation) return;
      this.beginPlayback(generation, restored.currentIndex ?? 0);
    } catch (error) {
      if (generation === this.generation) this.fail(error);
    }
  }

  togglePlayback(): void {
    const manager = this.dependencies.getManager();
    const snapshot = manager.getSnapshot();
    if (snapshot.source !== 'listen') {
      const session = useListenModeStore.getState().session;
      if (session) {
        void this.persist()
          .then(() => this.startDocument(session))
          .catch((error) => this.fail(error));
      }
      return;
    }
    if (snapshot.state === 'playing') manager.pause();
    else {
      useVoiceSessionStore.getState().pauseAudio();
      manager.resume();
    }
  }

  previous(): void {
    this.restartAtOffset(-1);
  }

  next(): void {
    this.restartAtOffset(1);
  }

  retry(): void {
    this.restartAtOffset(0);
  }

  stop(): void {
    this.queuePersist();
    this.generation++;
    this.abortSynthesis();
    this.detachManagerListeners();
    this.dependencies.getManager().interrupt();
    this.descriptor = null;
    useListenModeStore.setState({ session: null });
  }

  setPlaybackRate(playbackRate: ListenPlaybackRate): void {
    this.dependencies.getManager().setPlaybackRate(playbackRate);
    this.updateSession({ playbackRate });
    this.queuePersist();
  }

  setRetention(retention: ListenRetention): void {
    this.updateSession({ retention });
    this.queuePersist();
  }

  async clearAudio(): Promise<void> {
    const session = useListenModeStore.getState().session;
    if (!session) return;
    await this.dependencies.api.clearAudio(session.identity);
    this.updateSession({ cachedAnchors: [], cacheBytes: 0 });
  }

  private beginPlayback(generation: number, startIndex: number): void {
    const manager = this.dependencies.getManager();
    this.startIndex = startIndex;
    this.nextToPrepare = startIndex;
    this.desiredEnd = Math.min(startIndex + PREFETCH_AHEAD - 1, (this.descriptor?.sentences.length ?? 1) - 1);
    this.preparedCount = 0;
    this.lastProgressKey = '';
    const session = useListenModeStore.getState().session;
    this.resumeOffset = session?.currentTime ?? 0;
    useVoiceSessionStore.getState().stopAllAudio();
    manager.beginBatch('listen');
    manager.setPlaybackRate(session?.playbackRate ?? 1);
    this.unsubscribeSnapshot = manager.subscribe((snapshot) => this.handleSnapshot(generation, snapshot));
    this.unsubscribeItemEnd = manager.onItemEnd((relativeIndex) => this.handleItemEnd(generation, relativeIndex));
    void this.pump(generation);
  }

  private async pump(generation: number): Promise<void> {
    if (this.pumpingGeneration === generation) return;
    this.pumpingGeneration = generation;
    try {
      while (this.canPump(generation) && (await this.prepareNext(generation))) {}
      this.markDoneWhenPrepared();
    } catch (error) {
      if (generation === this.generation) this.fail(error);
    } finally {
      this.finishPump(generation);
    }
  }

  private canPump(generation: number): boolean {
    return generation === this.generation && this.nextToPrepare <= this.desiredEnd;
  }

  private async prepareNext(generation: number): Promise<boolean> {
    const descriptor = this.descriptor;
    const sentence = descriptor?.sentences[this.nextToPrepare];
    if (!sentence) return false;
    const asset = await this.consumeSynthesisStream(generation, sentence.text);
    if (!asset || !this.isCurrent(generation)) return false;
    const linked = await this.dependencies.api.linkAsset(
      descriptor.identity,
      sentence.anchor,
      asset.assetId,
      asset.synthesisFingerprint,
    );
    if (linked === false) return false;
    if (!this.isCurrent(generation)) return false;
    this.recordLinkedSentence(sentence.anchor, asset.bytes, asset.synthesisFingerprint);
    const enqueueResult = await this.dependencies.getManager().enqueueUrl(asset.audioUrl, this.dependencies.fetchAudio);
    if (!this.isCurrent(generation)) return false;
    if (enqueueResult === 'cancelled') {
      this.suspendAfterPlaybackCancellation(generation);
      return false;
    }
    if (enqueueResult === 'failed') throw new Error('完整音频加载失败，请重试');
    this.applyResumeOffset();
    this.recordFirstSegmentReady();
    this.recordPreparedSentence(sentence.anchor, asset.bytes);
    return true;
  }

  private async consumeSynthesisStream(generation: number, text: string) {
    this.abortSynthesis();
    const controller = new AbortController();
    this.synthesisAbort = controller;
    let asset: Extract<ListenSynthesisEvent, { type: 'asset' }> | null = null;
    try {
      for await (const event of this.dependencies.api.stream(text, controller.signal)) {
        if (!this.isCurrent(generation)) return null;
        // Each stream chunk is a standalone WAV. Playing those chunks as successive
        // HTMLAudio sources inserts a browser reload gap at every chunk boundary.
        // The stream still provides early synthesis/cache progress, while playback
        // consumes the complete sentence asset as one continuous audio item.
        if (event.type === 'asset') asset = event;
      }
    } finally {
      if (this.synthesisAbort === controller) this.synthesisAbort = null;
    }
    if (!asset) throw new Error('语音流结束但没有生成可缓存音频');
    return asset;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation && this.descriptor !== null;
  }

  private suspendAfterPlaybackCancellation(generation: number): void {
    if (!this.isCurrent(generation)) return;
    this.generation++;
    this.abortSynthesis();
    this.detachManagerListeners();
    this.updateSession({ phase: 'idle', error: null });
  }

  private applyResumeOffset(): void {
    if (this.nextToPrepare !== this.startIndex || this.resumeOffset <= 0) return;
    this.dependencies.getManager().seek(this.resumeOffset);
    this.resumeOffset = 0;
  }

  private recordPreparedSentence(anchor: string, bytes: number): void {
    this.preparedCount++;
    this.nextToPrepare++;
    this.recordFirstSegmentReady();
    const snapshot = this.dependencies.getManager().getSnapshot();
    const bufferDepth = Math.max(0, this.preparedCount - snapshot.itemIndex - 1);
    this.emitMetric('prefetch_buffer_segments', bufferDepth);
    const session = useListenModeStore.getState().session;
    if (!session || session.cachedAnchors.includes(anchor)) return;
    this.updateSession({
      cachedAnchors: [...session.cachedAnchors, anchor],
      cacheBytes: session.cacheBytes + bytes,
    });
  }

  private recordFirstSegmentReady(): void {
    if (!this.firstSegmentReady) {
      this.firstSegmentReady = true;
      this.emitMetric('first_segment_ready_ms', this.dependencies.now() - this.sessionStartedAt);
    }
  }

  private markDoneWhenPrepared(): void {
    if (this.descriptor && this.nextToPrepare >= this.descriptor.sentences.length) {
      this.dependencies.getManager().markDone();
    }
  }

  private finishPump(generation: number): void {
    if (this.pumpingGeneration === generation) this.pumpingGeneration = null;
    if (this.canPump(generation)) void this.pump(generation);
  }

  private handleSnapshot(generation: number, snapshot: PlaybackSnapshot): void {
    if (generation !== this.generation) return;
    if (snapshot.source === 'listen') {
      this.recordPlaybackHealth(snapshot);
      this.updateSession({
        phase: this.phaseFor(snapshot),
        currentTime: snapshot.currentTime,
        duration: snapshot.duration,
      });
      this.persistProgress(snapshot.currentTime);
      return;
    }
    if (snapshot.source === null && this.preparedCount > 0) this.updateSession({ phase: 'idle' });
  }

  private handleItemEnd(generation: number, relativeIndex: number): void {
    if (generation !== this.generation || !this.descriptor) return;
    const currentIndex = clampIndex(this.startIndex + relativeIndex + 1, this.descriptor.sentences.length);
    this.updateSession({ currentIndex, currentTime: 0, duration: 0 });
    this.lastProgressKey = '';
    this.desiredEnd = Math.min(currentIndex + PREFETCH_AHEAD - 1, this.descriptor.sentences.length - 1);
    this.queuePersist();
    void this.pump(generation);
  }

  private restartAtOffset(offset: number): void {
    const session = useListenModeStore.getState().session;
    if (!session) return;
    const target = clampIndex(session.currentIndex + offset, session.sentences.length);
    void this.startDocument(session, target);
  }

  private recordLinkedSentence(anchor: string, bytes: number, synthesisFingerprint?: string): void {
    const descriptor = this.descriptor;
    if (!descriptor) return;
    const key = listenDocumentCacheKey(descriptor.identity);
    useListenModeStore.setState((state) => {
      const current = state.cacheByDocument[key];
      const projection = current ?? {
        identity: descriptor.identity,
        cachedAnchors: [],
        cacheBytes: 0,
        totalSentences: descriptor.sentences.length,
        active: false,
        error: null,
      };
      if (projection.cachedAnchors.includes(anchor)) {
        if (!synthesisFingerprint || projection.synthesisFingerprint === synthesisFingerprint) return state;
        return {
          cacheByDocument: {
            ...state.cacheByDocument,
            [key]: { ...projection, synthesisFingerprint },
          },
        };
      }
      return {
        cacheByDocument: {
          ...state.cacheByDocument,
          [key]: {
            ...projection,
            ...(synthesisFingerprint ? { synthesisFingerprint } : {}),
            cachedAnchors: [...projection.cachedAnchors, anchor],
            cacheBytes: projection.cacheBytes + bytes,
          },
        },
      };
    });
  }

  private updateSession(patch: Partial<ListenModeSession>): void {
    useListenModeStore.setState(({ session }) => ({ session: session ? { ...session, ...patch } : null }));
  }

  private async persist(): Promise<void> {
    const session = useListenModeStore.getState().session;
    if (!session) return;
    const state = documentState(session, this.dependencies.now());
    const operation = this.persistTail.then(async () => {
      await this.dependencies.api.save(state);
    });
    this.persistTail = operation.catch(() => undefined);
    await operation;
  }

  private queuePersist(): void {
    void this.persist().catch((error) => this.fail(error));
  }

  private persistProgress(currentTime: number): void {
    const session = useListenModeStore.getState().session;
    const anchor = session?.sentences[session.currentIndex]?.anchor;
    if (!session || !anchor || currentTime <= 0) return;
    const progressKey = `${anchor}:${Math.floor(currentTime / 2)}`;
    if (progressKey === this.lastProgressKey) return;
    this.lastProgressKey = progressKey;
    this.queuePersist();
  }

  private fail(error: unknown): void {
    this.generation++;
    this.abortSynthesis();
    this.detachManagerListeners();
    this.dependencies.getManager().interrupt();
    this.updateSession({ phase: 'error', error: error instanceof Error ? error.message : '听读失败' });
  }

  private abortSynthesis(): void {
    this.synthesisAbort?.abort();
    this.synthesisAbort = null;
  }

  private recordPlaybackHealth(snapshot: PlaybackSnapshot): void {
    if (snapshot.state === 'playing') {
      this.underrunActive = false;
      if (!this.firstAudioPlayed) {
        this.firstAudioPlayed = true;
        this.emitMetric('first_audio_play_ms', this.dependencies.now() - this.sessionStartedAt);
      }
      return;
    }
    const hasMoreSentences = this.nextToPrepare < (this.descriptor?.sentences.length ?? 0);
    if (snapshot.state !== 'idle' || this.preparedCount === 0 || !hasMoreSentences || this.underrunActive) return;
    this.underrunActive = true;
    this.underrunCount++;
    this.emitMetric('buffer_underrun_count', this.underrunCount);
  }

  private phaseFor(snapshot: PlaybackSnapshot): ListenModeSession['phase'] {
    if (snapshot.state === 'playing') return 'playing';
    if (snapshot.state === 'paused') return 'paused';
    return this.preparedCount === 0 ? 'loading' : 'buffering';
  }

  private emitMetric(metric: ListenModeHealthMetric['metric'], value: number): void {
    const contentDigest = this.descriptor?.identity.contentDigest;
    if (!contentDigest) return;
    this.dependencies.telemetry({ feature: 'F279', metric, contentDigest, value: Math.max(0, value) });
  }

  private detachManagerListeners(): void {
    this.unsubscribeSnapshot?.();
    this.unsubscribeItemEnd?.();
    this.unsubscribeSnapshot = null;
    this.unsubscribeItemEnd = null;
  }
}

export const documentListenController = new DocumentListenController();
