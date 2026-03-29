'use client';

import type { VoiceChunkEvent, VoiceStreamEndEvent, VoiceStreamStartEvent } from '@cat-cafe/shared';
import { useCallback, useEffect } from 'react';
import { PlaybackManager } from '@/services/PlaybackManager';
import { useVoiceSessionStore } from '@/stores/voiceSessionStore';

let managerInstance: PlaybackManager | null = null;

function getOrCreateManager(): PlaybackManager {
  if (managerInstance) return managerInstance;
  managerInstance = new PlaybackManager({
    onStateChange: (state) => {
      const voiceStore = useVoiceSessionStore.getState();
      if (state === 'idle') {
        voiceStore.setPlaybackState('idle');
      } else if (state === 'playing') {
        voiceStore.setPlaybackState('playing');
      } else if (state === 'paused') {
        voiceStore.setPlaybackState('paused');
      }
    },
  });
  useVoiceSessionStore.getState().registerStopCallback('playback-manager', () => {
    managerInstance?.interrupt();
  });
  useVoiceSessionStore.getState().registerPlaybackControl('playback-manager', {
    pause: () => managerInstance?.pause(),
    resume: () => managerInstance?.resume(),
    skip: () => managerInstance?.skip(),
  });
  return managerInstance;
}

/** Get the shared PlaybackManager instance (creates if needed). Usable outside React. */
export function getPlaybackManager(): PlaybackManager {
  return getOrCreateManager();
}

function matchesActiveSession(event: { threadId: string; catId: string }): boolean {
  const { session } = useVoiceSessionStore.getState();
  if (!session?.voiceMode) return false;
  if (session.boundThreadId !== event.threadId) return false;
  if (session.activeCatId !== event.catId) return false;
  return true;
}

export function handleVoiceStreamStart(event: VoiceStreamStartEvent): void {
  if (!matchesActiveSession(event)) return;
  useVoiceSessionStore.getState().setLiveStreamActive(true, event.invocationId);
  getOrCreateManager().handleStreamStart(event);
}

export function handleVoiceChunk(event: VoiceChunkEvent): void {
  if (!matchesActiveSession(event)) return;
  const manager = getOrCreateManager();
  manager.handleChunk(event);
  useVoiceSessionStore.getState().confirmAutoplayUnlocked();
}

export function handleVoiceStreamEnd(event: VoiceStreamEndEvent): void {
  if (!matchesActiveSession(event)) return;
  getOrCreateManager().handleStreamEnd(event);
  useVoiceSessionStore.getState().setLiveStreamActive(false);
}

export function useVoiceStream(): {
  pause: () => void;
  resume: () => void;
  skip: () => void;
} {
  const session = useVoiceSessionStore((s) => s.session);

  useEffect(() => {
    if (!session?.voiceMode) {
      managerInstance?.interrupt();
    }
    return () => {
      managerInstance?.destroy();
      managerInstance = null;
    };
  }, [session?.voiceMode]);

  const pause = useCallback(() => managerInstance?.pause(), []);
  const resume = useCallback(() => managerInstance?.resume(), []);
  const skip = useCallback(() => managerInstance?.skip(), []);

  return { pause, resume, skip };
}
