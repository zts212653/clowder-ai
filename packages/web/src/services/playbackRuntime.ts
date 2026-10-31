'use client';

import { PlaybackManager } from '@/services/PlaybackManager';
import { useVoiceSessionStore } from '@/stores/voiceSessionStore';

interface PlaybackRuntime {
  manager: PlaybackManager;
  unregisterControls: () => void;
  unregisterStop: () => void;
}

let runtime: PlaybackRuntime | null = null;

function createPlaybackRuntime(): PlaybackRuntime {
  const manager = new PlaybackManager({
    onStateChange: (state) => {
      useVoiceSessionStore.getState().setPlaybackState(state);
    },
  });
  const voiceStore = useVoiceSessionStore.getState();
  const unregisterStop = voiceStore.registerStopCallback('playback-manager', () => manager.interrupt());
  const unregisterControls = voiceStore.registerPlaybackControl('playback-manager', {
    pause: () => manager.pause(),
    resume: () => manager.resume(),
    skip: () => manager.skip(),
  });
  return { manager, unregisterControls, unregisterStop };
}

/** Shared playback runtime owned by AppShell rather than a thread-local ChatContainer. */
export function getPlaybackManager(): PlaybackManager {
  runtime ??= createPlaybackRuntime();
  return runtime.manager;
}

/** Read without creating; admission policies must not wake audio just to inspect it. */
export function peekPlaybackManager(): PlaybackManager | null {
  return runtime?.manager ?? null;
}

/** Terminal page-shell teardown. Route/thread/voice-mode changes must never call this. */
export function destroyPlaybackRuntime(): void {
  const current = runtime;
  if (!current) return;
  runtime = null;
  current.unregisterControls();
  current.unregisterStop();
  current.manager.destroy();
}
