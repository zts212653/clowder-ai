'use client';

import { useEffect, useRef } from 'react';
import type { RichAudioBlock } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useVoiceSessionStore } from '@/stores/voiceSessionStore';
import { apiFetch } from '@/utils/api-client';
import { base64ToBlob, streamTts } from '@/utils/tts-stream';

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
 *
 * F111: When a voice block has `text` but no `url`, uses /api/tts/stream
 * for chunked streaming playback (<2s first-audio latency).
 */

let autoplayAudio: HTMLAudioElement | null = null;
let autoplayBlobUrl: string | null = null;
let streamingAbort: AbortController | null = null;
let streamingBlobUrls: string[] = [];
let unregisterStop: (() => void) | null = null;

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
  streamingAbort?.abort();
  streamingAbort = null;
  unregisterStop?.();
  unregisterStop = null;
  if (autoplayAudio) {
    autoplayAudio.pause();
    autoplayAudio.removeAttribute('src');
    autoplayAudio.onended = null;
    autoplayAudio.onerror = null;
  }
  if (autoplayBlobUrl) {
    URL.revokeObjectURL(autoplayBlobUrl);
    autoplayBlobUrl = null;
  }
  for (const url of streamingBlobUrls) {
    URL.revokeObjectURL(url);
  }
  streamingBlobUrls = [];
}

function hasStreamableText(block: RichAudioBlock): boolean {
  return !!block.text?.trim() && !block.url;
}

async function streamAndPlay(block: RichAudioBlock, originSessionId: string): Promise<void> {
  cleanupAutoplay();
  registerAutoplayStop();

  const { markPlayed, setPlaybackState, confirmAutoplayUnlocked } = useVoiceSessionStore.getState();

  function isSessionStale(): boolean {
    const { session } = useVoiceSessionStore.getState();
    return !session?.voiceMode || session.sessionId !== originSessionId;
  }

  streamingAbort = new AbortController();
  const audio = getAutoplayAudio();
  const queue: string[] = [];
  let firstChunkPlayed = false;
  let streamDone = false;

  const playNext = () => {
    if (queue.length === 0) {
      if (streamDone) setPlaybackState('idle');
      return;
    }
    const nextUrl = queue.shift()!;
    audio.src = nextUrl;
    audio.play().catch(() => setPlaybackState('idle'));
  };

  audio.onended = playNext;
  audio.onerror = () => setPlaybackState('idle');

  try {
    setPlaybackState('playing');

    for await (const event of streamTts(
      {
        text: block.text!,
        catId: useVoiceSessionStore.getState().session?.activeCatId,
      },
      streamingAbort.signal,
    )) {
      if (streamingAbort.signal.aborted || isSessionStale()) break;

      if (event.type === 'chunk' && event.audioBase64) {
        const mimeType = event.format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
        const blob = base64ToBlob(event.audioBase64, mimeType);
        const blobUrl = URL.createObjectURL(blob);
        streamingBlobUrls.push(blobUrl);

        if (!firstChunkPlayed) {
          firstChunkPlayed = true;
          audio.src = blobUrl;
          await audio.play();
          confirmAutoplayUnlocked();
          markPlayed(block.id);
        } else {
          queue.push(blobUrl);
          if (audio.ended) playNext();
        }
      }
    }

    streamDone = true;
    if (queue.length === 0 && (!firstChunkPlayed || audio.ended)) {
      setPlaybackState('idle');
    }
  } catch {
    if (!streamingAbort?.signal.aborted) {
      setPlaybackState('idle');
    }
  }
}

async function fetchAndPlay(block: RichAudioBlock, originSessionId: string): Promise<void> {
  cleanupAutoplay();
  registerAutoplayStop();

  const { markPlayed, setPlaybackState, confirmAutoplayUnlocked } = useVoiceSessionStore.getState();

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
    confirmAutoplayUnlocked();
    markPlayed(block.id);
  } catch {
    setPlaybackState('idle');
  }
}

/** Scan messages for the oldest unplayed audio block (FIFO playback order). */
function findUnplayedAudioBlock(
  newMessages: ReadonlyArray<{
    type: string;
    extra?: { rich?: { blocks: Array<{ kind: string; id: string }> }; stream?: { invocationId?: string } };
  }>,
): RichAudioBlock | null {
  for (let i = 0; i < newMessages.length; i++) {
    const msg = newMessages[i];
    if (msg.type !== 'assistant') continue;

    const blocks = msg.extra?.rich?.blocks;
    if (!blocks) continue;

    // Skip audio blocks from invocations that already had live streaming
    const msgInvocationId = msg.extra?.stream?.invocationId;
    if (msgInvocationId && useVoiceSessionStore.getState().isLiveStreamedInvocation(msgInvocationId)) {
      for (const block of blocks) {
        if (block.kind === 'audio') {
          useVoiceSessionStore.getState().markPlayed(block.id);
        }
      }
      continue;
    }

    const audioBlocks = blocks.filter((b): b is RichAudioBlock => b.kind === 'audio');
    for (const block of audioBlocks) {
      if (!useVoiceSessionStore.getState().hasPlayed(block.id)) {
        return block;
      }
    }
  }
  return null;
}

function registerAutoplayStop(): void {
  unregisterStop?.();
  unregisterStop = useVoiceSessionStore.getState().registerStopCallback('autoplay', () => {
    cleanupAutoplay();
    useVoiceSessionStore.getState().setPlaybackState('idle');
  });
}

function playBlock(block: RichAudioBlock, sessionId: string): void {
  if (hasStreamableText(block)) {
    streamAndPlay(block, sessionId);
  } else {
    fetchAndPlay(block, sessionId);
  }
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

    if (session.liveStreamActive) {
      prevMessageCountRef.current = messages.length;
      return;
    }

    if (currentThreadId !== session.boundThreadId) {
      prevMessageCountRef.current = 0;
      prevThreadIdRef.current = currentThreadId;
      return;
    }

    const threadChanged = prevThreadIdRef.current !== currentThreadId;
    prevThreadIdRef.current = currentThreadId;

    if (threadChanged) {
      prevMessageCountRef.current = messages.length;
      return;
    }

    const isNewSession = prevSessionIdRef.current !== session.sessionId;
    prevSessionIdRef.current = session.sessionId;

    if (isNewSession) {
      const block = findUnplayedAudioBlock(messages);
      prevMessageCountRef.current = messages.length;
      if (block) playBlock(block, session.sessionId);
      return;
    }

    const prevCount = prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;

    if (messages.length <= prevCount) return;

    const block = findUnplayedAudioBlock(messages.slice(prevCount));
    if (block) playBlock(block, session.sessionId);
  }, [messages, session, currentThreadId]);

  useEffect(() => {
    if (!session?.voiceMode) {
      cleanupAutoplay();
    }
    return () => cleanupAutoplay();
  }, [session?.voiceMode]);
}
