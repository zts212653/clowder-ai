'use client';

import { useEffect, useRef } from 'react';
import type { RichAudioBlock } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useVoiceSessionStore } from '@/stores/voiceSessionStore';
import { apiFetch } from '@/utils/api-client';

/**
 * F092: Auto-play incoming audio blocks when Voice Companion is active.
 *
 * Watches the message list for new assistant messages containing audio blocks.
 * When voice mode is on + autoplay unlocked, plays them automatically.
 *
 * Uses a module-level singleton Audio element **attached to the DOM**
 * to ensure only one auto-play at a time.
 *
 * F124 fix: on iOS, a detached `new Audio()` element may not route audio
 * to hardware output (speakers/AirPods) even though screen recording
 * captures it.  We now create a persistent hidden `<audio>` element in the
 * DOM and reuse it for all auto-play, matching how AudioBlock.tsx works.
 */

let autoplayAudio: HTMLAudioElement | null = null;
let autoplayBlobUrl: string | null = null;

/** Get or create a persistent, DOM-attached audio element for autoplay. */
function getAutoplayAudio(): HTMLAudioElement {
  if (autoplayAudio) return autoplayAudio;
  const audio = document.createElement('audio');
  audio.id = 'voice-autoplay-audio';
  audio.style.display = 'none';
  audio.preload = 'auto';
  document.body.appendChild(audio);
  autoplayAudio = audio;
  return audio;
}

function cleanupAutoplay(): void {
  if (autoplayAudio) {
    autoplayAudio.pause();
    autoplayAudio.removeAttribute('src');
    autoplayAudio.onended = null;
    autoplayAudio.onerror = null;
    // Keep the element in the DOM — reuse across plays
  }
  if (autoplayBlobUrl) {
    URL.revokeObjectURL(autoplayBlobUrl);
    autoplayBlobUrl = null;
  }
}

async function fetchAndPlay(block: RichAudioBlock, originSessionId: string): Promise<void> {
  cleanupAutoplay();

  const { markPlayed, setPlaybackState, confirmAutoplayUnlocked } = useVoiceSessionStore.getState();

  /** Check that the session that triggered this play is still the active one */
  function isSessionStale(): boolean {
    const { session } = useVoiceSessionStore.getState();
    return !session?.voiceMode || session.sessionId !== originSessionId;
  }

  try {
    let blobUrl: string;

    if (block.url.startsWith('/api/')) {
      const res = await apiFetch(block.url);
      if (!res.ok) return;
      if (isSessionStale()) {
        cleanupAutoplay();
        return;
      }
      const blob = await res.blob();
      blobUrl = URL.createObjectURL(blob);
      autoplayBlobUrl = blobUrl;
    } else {
      blobUrl = block.url;
    }

    if (isSessionStale()) {
      cleanupAutoplay();
      return;
    }

    const audio = getAutoplayAudio();
    audio.src = blobUrl;
    setPlaybackState('playing');

    audio.onended = () => {
      setPlaybackState('idle');
    };
    audio.onerror = () => {
      setPlaybackState('idle');
    };

    await audio.play();
    // First successful play confirms autoplay is truly unlocked
    confirmAutoplayUnlocked();
    markPlayed(block.id);
  } catch {
    setPlaybackState('idle');
  }
}

/** Scan messages for the oldest unplayed audio block (FIFO playback order). */
function findUnplayedAudioBlock(
  newMessages: ReadonlyArray<{ type: string; extra?: { rich?: { blocks: Array<{ kind: string; id: string }> } } }>,
): RichAudioBlock | null {
  for (let i = 0; i < newMessages.length; i++) {
    const msg = newMessages[i];
    if (msg.type !== 'assistant') continue;

    const blocks = msg.extra?.rich?.blocks;
    if (!blocks) continue;

    const audioBlocks = blocks.filter((b): b is RichAudioBlock => b.kind === 'audio');
    for (const block of audioBlocks) {
      if (!useVoiceSessionStore.getState().hasPlayed(block.id)) {
        return block;
      }
    }
  }
  return null;
}

export function useVoiceAutoPlay(): void {
  const messages = useChatStore((s) => s.messages);
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const session = useVoiceSessionStore((s) => s.session);
  const prevMessageCountRef = useRef(messages.length);
  const prevSessionIdRef = useRef<string | null>(null);
  const prevThreadIdRef = useRef<string>(currentThreadId);

  useEffect(() => {
    if (!session?.voiceMode) {
      prevMessageCountRef.current = messages.length;
      prevSessionIdRef.current = null;
      prevThreadIdRef.current = currentThreadId;
      return;
    }

    // Guard: only auto-play when viewing the bound thread
    if (currentThreadId !== session.boundThreadId) {
      // Thread switched away — reset prevCount so returning doesn't replay
      prevMessageCountRef.current = 0;
      prevThreadIdRef.current = currentThreadId;
      return;
    }

    const threadChanged = prevThreadIdRef.current !== currentThreadId;
    prevThreadIdRef.current = currentThreadId;

    // If we just switched back to the bound thread, reset message tracking
    // to current length to avoid replaying old messages
    if (threadChanged) {
      prevMessageCountRef.current = messages.length;
      return;
    }

    const isNewSession = prevSessionIdRef.current !== session.sessionId;
    prevSessionIdRef.current = session.sessionId;

    if (isNewSession) {
      // Voice companion just activated — scan ALL existing messages for
      // the latest unplayed audio block and play it immediately.
      const block = findUnplayedAudioBlock(messages);
      prevMessageCountRef.current = messages.length;
      if (block) fetchAndPlay(block, session.sessionId);
      return;
    }

    // Ongoing session — only look at newly added messages
    const prevCount = prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;

    if (messages.length <= prevCount) return;

    const block = findUnplayedAudioBlock(messages.slice(prevCount));
    if (block) fetchAndPlay(block, session.sessionId);
  }, [messages, session, currentThreadId]);

  // Cleanup on unmount or voice mode stop
  useEffect(() => {
    if (!session?.voiceMode) {
      cleanupAutoplay();
    }
    return () => cleanupAutoplay();
  }, [session?.voiceMode]);
}
