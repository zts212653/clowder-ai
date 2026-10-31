/**
 * F34: TTS Hook — synthesize and play cat voice audio.
 *
 * Uses module-level singletons for Audio + AbortController so that
 * multiple hook instances (one per ChatMessage) share a single playback.
 * Only one audio can play at a time (global mutex via singleton Audio).
 *
 * R5-P1 fix: previous version used per-instance useState/useRef which
 * broke cross-message playback mutex when each ChatMessage had its own hook.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { peekPlaybackManager } from '@/services/playbackRuntime';
import { apiFetch } from '@/utils/api-client';

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

/** Per-message blob URL cache with LRU eviction + revoke */
const URL_CACHE_MAX = 20;
const urlCache = new Map<string, string>();

function cacheBlobUrl(messageId: string, blobUrl: string): void {
  // Revoke if overwriting existing entry
  const existing = urlCache.get(messageId);
  if (existing) {
    URL.revokeObjectURL(existing);
    urlCache.delete(messageId); // re-insert at end for LRU ordering
  }
  // Evict oldest (first entry in Map) if at capacity
  if (urlCache.size >= URL_CACHE_MAX) {
    const oldest = urlCache.keys().next().value;
    if (oldest) {
      const oldUrl = urlCache.get(oldest);
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      urlCache.delete(oldest);
    }
  }
  urlCache.set(messageId, blobUrl);
}

/** Singleton audio element — guarantees only one playback at a time */
let currentAudio: HTMLAudioElement | null = null;
let currentAbort: AbortController | null = null;

function stopPlayback(): void {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio = null;
  }
  if (currentAbort) {
    currentAbort.abort();
    currentAbort = null;
  }
  emit({ state: 'idle', activeMessageId: null });
}

function playAudio(url: string, messageId: string): void {
  const audio = new Audio(url);
  currentAudio = audio;
  emit({ state: 'playing', activeMessageId: messageId });
  audio.onended = () => {
    if (currentAudio === audio) stopPlayback();
  };
  audio.onerror = () => {
    if (currentAudio === audio) emit({ state: 'error', activeMessageId: messageId });
  };
  audio.play().catch(() => {
    // Browser autoplay policy blocked — transition to error so fallback UI shows
    if (currentAudio === audio) emit({ state: 'error', activeMessageId: messageId });
  });
}

function synthesize(messageId: string, text: string, catId?: string): void {
  // Toggle off if already playing this message
  if (store.activeMessageId === messageId && store.state === 'playing') {
    stopPlayback();
    return;
  }

  // Stop any current playback first (global mutex)
  peekPlaybackManager()?.interrupt();
  stopPlayback();

  const cached = urlCache.get(messageId);
  if (cached) {
    playAudio(cached, messageId);
    return;
  }

  // Synthesize via API
  emit({ state: 'loading', activeMessageId: messageId });
  const controller = new AbortController();
  currentAbort = controller;

  apiFetch('/api/tts/synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, catId }),
    signal: controller.signal,
  })
    .then((res) => {
      if (!res.ok) throw new Error(`TTS API ${res.status}`);
      return res.json();
    })
    .then((data: { audioUrl: string }) => {
      // Check if this request was superseded by another
      if (store.activeMessageId !== messageId) return;
      // Fetch audio via apiFetch (carries auth header) → blob URL
      return apiFetch(data.audioUrl)
        .then((audioRes) => {
          if (!audioRes.ok) throw new Error(`TTS audio ${audioRes.status}`);
          if (store.activeMessageId !== messageId) return;
          return audioRes.blob();
        })
        .then((blob) => {
          if (!blob || store.activeMessageId !== messageId) return;
          const blobUrl = URL.createObjectURL(blob);
          cacheBlobUrl(messageId, blobUrl);
          playAudio(blobUrl, messageId);
        });
    })
    .catch((err) => {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('[useTts] synthesis failed:', err);
      if (store.activeMessageId === messageId) {
        emit({ state: 'error', activeMessageId: messageId });
      }
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
