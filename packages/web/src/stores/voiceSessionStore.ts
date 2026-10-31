'use client';

import { create } from 'zustand';
import { apiFetch } from '@/utils/api-client';

/**
 * F092: Voice Companion Session — manages voice mode state.
 *
 * VoiceSession is ephemeral (memory only, no persistence).
 * Closing the page ends the session.
 *
 * P0 scope: one thread, one cat, auto-play, PTT.
 */

export type PlaybackState = 'idle' | 'playing' | 'paused';

export interface VoiceSession {
  sessionId: string;
  boundThreadId: string;
  activeCatId: string;
  voiceMode: boolean;
  /** Whether user gesture has unlocked browser autoplay */
  autoplayUnlocked: boolean;
  playbackState: PlaybackState;
  /** Track which audio block IDs have been auto-played (avoid replays on re-render) */
  playedBlockIds: Set<string>;
  /** True when a live voice stream is active (suppresses fallback auto-play) */
  liveStreamActive: boolean;
  /** Invocation IDs that had live streaming (their audio blocks skip fallback) */
  liveStreamedInvocationIds: Set<string>;
}

/** Notify backend about voice mode toggle for prompt injection. */
function syncVoiceModeToBackend(threadId: string, voiceMode: boolean, keepalive = false): void {
  apiFetch(`/api/threads/${threadId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voiceMode }),
    keepalive,
  }).catch(() => {
    // Best-effort — voice mode prompt injection is non-critical path
  });
}

interface VoiceSessionActions {
  session: VoiceSession | null;
  start: (threadId: string, catId: string, autoplayUnlocked: boolean) => void;
  stop: () => void;
  setPlaybackState: (state: PlaybackState) => void;
  confirmAutoplayUnlocked: () => void;
  markPlayed: (blockId: string) => void;
  hasPlayed: (blockId: string) => boolean;
  setLiveStreamActive: (active: boolean, invocationId?: string) => void;
  isLiveStreamedInvocation: (invocationId: string) => boolean;
  /**
   * F112-C: Register a stop callback so VAD can interrupt any active playback path.
   * Both PlaybackManager (live stream) and useVoiceAutoPlay (fallback) register here.
   * Returns an unregister function.
   */
  registerStopCallback: (id: string, fn: () => void) => () => void;
  /** F112-C: Invoke all registered stop callbacks (called by VAD on speech detection). */
  stopAllAudio: () => void;
  /**
   * Register centralized playback controls (pause/resume/skip) for an audio path.
   * Both PlaybackManager and autoplay register here so the UI can control whichever is active.
   * Returns an unregister function.
   */
  registerPlaybackControl: (
    id: string,
    control: { pause: () => void; resume: () => void; skip: () => void },
  ) => () => void;
  /** Pause all active audio playback paths. */
  pauseAudio: () => void;
  /** Resume all paused audio playback paths. */
  resumeAudio: () => void;
  /** Skip current audio in all active playback paths. */
  skipAudio: () => void;
}

let sessionCounter = 0;
const stopCallbacks = new Map<string, () => void>();
const playbackControls = new Map<string, { pause: () => void; resume: () => void; skip: () => void }>();

export const useVoiceSessionStore = create<VoiceSessionActions>((set, get) => ({
  session: null,

  start: (threadId, catId, autoplayUnlocked) => {
    // Clear old thread's voiceMode if switching threads
    const prev = get().session;
    if (prev?.boundThreadId && prev.boundThreadId !== threadId) {
      syncVoiceModeToBackend(prev.boundThreadId, false);
    }
    sessionCounter++;
    set({
      session: {
        sessionId: `vs-${Date.now()}-${sessionCounter}`,
        boundThreadId: threadId,
        activeCatId: catId,
        voiceMode: true,
        autoplayUnlocked,
        playbackState: 'idle',
        playedBlockIds: new Set(),
        liveStreamActive: false,
        liveStreamedInvocationIds: new Set(),
      },
    });
    syncVoiceModeToBackend(threadId, true);
  },

  stop: () => {
    const { session } = get();
    set({ session: null });
    if (session?.boundThreadId) {
      syncVoiceModeToBackend(session.boundThreadId, false);
    }
  },

  confirmAutoplayUnlocked: () => {
    const { session } = get();
    if (!session) return;
    set({ session: { ...session, autoplayUnlocked: true } });
  },

  setPlaybackState: (playbackState) => {
    const { session } = get();
    if (!session) return;
    set({ session: { ...session, playbackState } });
  },

  markPlayed: (blockId) => {
    const { session } = get();
    if (!session) return;
    const next = new Set(session.playedBlockIds);
    next.add(blockId);
    set({ session: { ...session, playedBlockIds: next } });
  },

  hasPlayed: (blockId) => {
    const { session } = get();
    return session?.playedBlockIds.has(blockId) ?? false;
  },

  setLiveStreamActive: (active, invocationId) => {
    const { session } = get();
    if (!session) return;
    const nextIds = new Set(session.liveStreamedInvocationIds);
    if (active && invocationId) {
      nextIds.add(invocationId);
    }
    set({ session: { ...session, liveStreamActive: active, liveStreamedInvocationIds: nextIds } });
  },

  isLiveStreamedInvocation: (invocationId) => {
    const { session } = get();
    return session?.liveStreamedInvocationIds.has(invocationId) ?? false;
  },

  registerStopCallback: (id, fn) => {
    stopCallbacks.set(id, fn);
    return () => {
      stopCallbacks.delete(id);
    };
  },

  stopAllAudio: () => {
    for (const fn of stopCallbacks.values()) {
      fn();
    }
  },

  registerPlaybackControl: (id, control) => {
    playbackControls.set(id, control);
    return () => {
      playbackControls.delete(id);
    };
  },

  pauseAudio: () => {
    // Snapshot to avoid mutation during iteration (skip can delete+re-add keys)
    for (const ctrl of [...playbackControls.values()]) {
      ctrl.pause();
    }
  },

  resumeAudio: () => {
    for (const ctrl of [...playbackControls.values()]) {
      ctrl.resume();
    }
  },

  skipAudio: () => {
    for (const ctrl of [...playbackControls.values()]) {
      ctrl.skip();
    }
  },
}));

// Clean up voiceMode in Redis when the page unloads (tab close, navigation, etc.)
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    const { session } = useVoiceSessionStore.getState();
    if (session?.voiceMode && session.boundThreadId) {
      syncVoiceModeToBackend(session.boundThreadId, false, true);
    }
  });
}
