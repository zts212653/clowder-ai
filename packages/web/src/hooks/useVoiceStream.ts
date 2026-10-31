'use client';

import type { VoiceChunkEvent, VoiceStreamEndEvent, VoiceStreamStartEvent } from '@cat-cafe/shared';
import { useCallback, useEffect } from 'react';
import { getPlaybackManager, peekPlaybackManager } from '@/services/playbackRuntime';
import { useListenModeStore } from '@/stores/listenModeStore';
import { useVoiceSessionStore } from '@/stores/voiceSessionStore';

export { getPlaybackManager } from '@/services/playbackRuntime';

function matchesActiveSession(event: { threadId: string; catId: string }): boolean {
  if (useListenModeStore.getState().session) return false;
  if (peekPlaybackManager()?.getSnapshot().source === 'listen') return false;
  const { session } = useVoiceSessionStore.getState();
  if (!session?.voiceMode) return false;
  if (session.boundThreadId !== event.threadId) return false;
  if (session.activeCatId !== event.catId) return false;
  return true;
}

export function handleVoiceStreamStart(event: VoiceStreamStartEvent): void {
  if (!matchesActiveSession(event)) return;
  useVoiceSessionStore.getState().setLiveStreamActive(true, event.invocationId);
  getPlaybackManager().handleStreamStart(event);
}

export function handleVoiceChunk(event: VoiceChunkEvent): void {
  if (!matchesActiveSession(event)) return;
  const manager = getPlaybackManager();
  manager.handleChunk(event);
  useVoiceSessionStore.getState().confirmAutoplayUnlocked();
}

export function handleVoiceStreamEnd(event: VoiceStreamEndEvent): void {
  if (!matchesActiveSession(event)) return;
  getPlaybackManager().handleStreamEnd(event);
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
      const manager = peekPlaybackManager();
      if (manager?.getActiveInvocationId()) manager.interrupt();
    }
  }, [session?.voiceMode]);

  const pause = useCallback(() => peekPlaybackManager()?.pause(), []);
  const resume = useCallback(() => peekPlaybackManager()?.resume(), []);
  const skip = useCallback(() => peekPlaybackManager()?.skip(), []);

  return { pause, resume, skip };
}
