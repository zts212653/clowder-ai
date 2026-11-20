import { useCallback, useSyncExternalStore } from 'react';
import { type SynthesizedListenAsset, streamListenSynthesis } from '@/services/listenModeApi';
import type { PlaybackManager, PlaybackSnapshot } from '@/services/PlaybackManager';
import { getPlaybackManager } from '@/services/playbackRuntime';
import type { ReadAloudPcm } from '@/services/ReadAloudPcm';
import { useVoiceSessionStore } from '@/stores/voiceSessionStore';
import { apiFetch } from '@/utils/api-client';
import { showTtsVoiceWarning } from '@/utils/tts-voice-warning';

export type TtsState = 'idle' | 'loading' | 'playing' | 'error';

interface TtsStore {
  state: TtsState;
  activeMessageId: string | null;
}

// ── Module-level singleton state (shared across all hook instances) ──

let store: TtsStore = { state: 'idle', activeMessageId: null };
const listeners = new Set<() => void>();

function getSnapshot(): TtsStore {
  return store;
}

function emit(next: TtsStore): void {
  store = next;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

interface ReadAloudPlayback {
  messageId: string;
  manager: PlaybackManager;
  controller: AbortController;
  unsubscribe?: () => void;
}

let currentPlayback: ReadAloudPlayback | null = null;

function stopPlayback(state: 'idle' | 'error' = 'idle'): void {
  const playback = currentPlayback;
  currentPlayback = null;
  if (playback) {
    playback.unsubscribe?.();
    playback.controller.abort();
    if (playback.manager.getSnapshot().source === 'read-aloud') playback.manager.interrupt();
  }
  emit({ state, activeMessageId: state === 'error' ? (playback?.messageId ?? null) : null });
}

function observePlayback(playback: ReadAloudPlayback, snapshot: PlaybackSnapshot): void {
  if (currentPlayback !== playback) return;
  if (snapshot.source !== 'read-aloud') {
    stopPlayback();
  } else if (snapshot.state === 'playing' && store.state !== 'playing') {
    emit({ state: 'playing', activeMessageId: playback.messageId });
  }
}

async function queueReadAloudAsset(
  playback: ReadAloudPlayback,
  asset: SynthesizedListenAsset,
  pcm: ReadAloudPcm | null,
) {
  showTtsVoiceWarning(asset.voiceSelection);
  const fetchAsset = (url: string) => apiFetch(url, { signal: playback.controller.signal });
  if (pcm) {
    await pcm.finishSentence(asset.pcmChunkCount, async () => {
      const response = await fetchAsset(asset.audioUrl);
      if (!response.ok) throw new Error('Read-aloud audio could not be loaded');
      return response.arrayBuffer();
    });
    return;
  }
  const queued = await playback.manager.enqueueUrl(asset.audioUrl, fetchAsset);
  if (queued !== 'enqueued' && currentPlayback === playback) throw new Error('Read-aloud audio could not be loaded');
}

async function readAloud(playback: ReadAloudPlayback, text: string, catId?: string): Promise<void> {
  const { manager, controller } = playback;
  const beganAt = performance.now();
  const streamPcm = typeof AudioContext === 'function' ? (true as const) : undefined;
  const output: { pcm: ReadAloudPcm | null } = { pcm: null };
  let outputChosen = false;
  let receivedAudio = false;
  const request = { text, catId, purpose: 'read-aloud' as const, streamPcm };
  const events = streamListenSynthesis(request, controller.signal, () => {
    // A device can block briefly while opening. The server can synthesize while it opens.
    if (streamPcm && currentPlayback === playback) output.pcm = manager.prepareReadAloudPcm(beganAt);
  });
  for await (const event of events) {
    if (currentPlayback !== playback) return;
    if (!outputChosen) {
      outputChosen = true;
      if (output.pcm && !output.pcm.ready) {
        manager.discardReadAloudPcm(output.pcm);
        output.pcm = null;
      }
    }
    const { pcm } = output;
    if (event.type === 'chunk') {
      if (pcm && event.chunkIndex !== undefined) pcm.pushChunk({ ...event, chunkIndex: event.chunkIndex });
      continue;
    }
    await queueReadAloudAsset(playback, event, pcm);
    if (currentPlayback !== playback) return;
    receivedAudio = true;
  }
  if (currentPlayback !== playback) return;
  if (!receivedAudio) throw new Error('Read-aloud stream ended without audio');
  manager.markDone();
  if (manager.getState() === 'idle') stopPlayback();
}

function synthesize(messageId: string, text: string, catId?: string): void {
  if (store.activeMessageId === messageId && currentPlayback) {
    stopPlayback();
    return;
  }

  stopPlayback();
  const manager = getPlaybackManager();
  useVoiceSessionStore.getState().stopAllAudio();
  const playback: ReadAloudPlayback = { messageId, manager, controller: new AbortController() };
  manager.beginBatch('read-aloud', () => {
    if (currentPlayback === playback) stopPlayback('error');
  });
  manager.setPlaybackRate(1);
  currentPlayback = playback;
  emit({ state: 'loading', activeMessageId: messageId });
  playback.unsubscribe = manager.subscribe((snapshot) => observePlayback(playback, snapshot));

  void readAloud(playback, text, catId).catch((error) => {
    if (currentPlayback !== playback) return;
    console.error('[useTts] read aloud failed:', error);
    stopPlayback('error');
  });
}

// ── Public hook ──

export interface UseTtsReturn {
  state: TtsState;
  synthesize: (messageId: string, text: string, catId?: string) => void;
  stop: () => void;
  activeMessageId: string | null;
}

export function useTts(): UseTtsReturn {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const stableSynthesize = useCallback(
    (messageId: string, text: string, catId?: string) => synthesize(messageId, text, catId),
    [],
  );

  const stableStop = useCallback(() => stopPlayback(), []);

  return {
    state: snap.state,
    activeMessageId: snap.activeMessageId,
    synthesize: stableSynthesize,
    stop: stableStop,
  };
}
