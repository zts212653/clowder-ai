'use client';

import type { TtsStreamRequest } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { base64ToBlob, streamTts } from '@/utils/tts-stream';

interface StreamingAudioState {
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'done' | 'error';
  currentIndex: number;
  totalChunks: number;
  progress: number;
  error?: string;
}

export function useStreamingAudio() {
  const [state, setState] = useState<StreamingAudioState>({
    status: 'idle',
    currentIndex: 0,
    totalChunks: 0,
    progress: 0,
  });

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const queueRef = useRef<string[]>([]);
  const blobUrlsRef = useRef<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const streamDoneRef = useRef(false);
  const onEndedRef = useRef<(() => void) | null>(null);
  const onTimeUpdateRef = useRef<(() => void) | null>(null);

  const removeListeners = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (onEndedRef.current) audio.removeEventListener('ended', onEndedRef.current);
    if (onTimeUpdateRef.current) audio.removeEventListener('timeupdate', onTimeUpdateRef.current);
    onEndedRef.current = null;
    onTimeUpdateRef.current = null;
  }, []);

  const cleanup = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    removeListeners();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
    }
    for (const url of blobUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
    blobUrlsRef.current = [];
    queueRef.current = [];
    streamDoneRef.current = false;
  }, [removeListeners]);

  useEffect(() => cleanup, [cleanup]);

  const playNext = useCallback(() => {
    const queue = queueRef.current;
    const audio = audioRef.current;
    if (!audio || queue.length === 0) {
      if (streamDoneRef.current) {
        setState((s) => ({ ...s, status: 'done' }));
      }
      return;
    }

    const nextUrl = queue.shift()!;
    audio.src = nextUrl;
    audio.play().catch(() => {
      setState((s) => ({ ...s, status: 'error', error: 'Playback failed' }));
    });
  }, []);

  const start = useCallback(
    async (request: TtsStreamRequest, audioElement: HTMLAudioElement) => {
      cleanup();
      audioRef.current = audioElement;
      abortRef.current = new AbortController();

      setState({ status: 'loading', currentIndex: 0, totalChunks: 0, progress: 0 });

      let firstChunkPlayed = false;
      let chunkCount = 0;

      const onEnded = () => {
        setState((s) => {
          const nextIdx = s.currentIndex + 1;
          return {
            ...s,
            currentIndex: nextIdx,
            progress: s.totalChunks > 0 ? nextIdx / s.totalChunks : 0,
          };
        });
        playNext();
      };

      const onTimeUpdate = () => {
        if (!audioElement.duration || audioElement.duration <= 0) return;
        setState((s) => {
          const chunkProgress = audioElement.currentTime / audioElement.duration;
          const baseProgress = s.totalChunks > 0 ? s.currentIndex / s.totalChunks : 0;
          const chunkWeight = s.totalChunks > 0 ? 1 / s.totalChunks : 1;
          return { ...s, progress: baseProgress + chunkProgress * chunkWeight };
        });
      };

      onEndedRef.current = onEnded;
      onTimeUpdateRef.current = onTimeUpdate;
      audioElement.addEventListener('ended', onEnded);
      audioElement.addEventListener('timeupdate', onTimeUpdate);

      try {
        for await (const event of streamTts(request, abortRef.current.signal)) {
          if (abortRef.current?.signal.aborted) break;

          if (event.type === 'chunk' && event.audioBase64) {
            chunkCount++;
            const mimeType = event.format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
            const blob = base64ToBlob(event.audioBase64, mimeType);
            const blobUrl = URL.createObjectURL(blob);
            blobUrlsRef.current.push(blobUrl);

            setState((s) => ({
              ...s,
              totalChunks: event.total ?? chunkCount,
            }));

            if (!firstChunkPlayed) {
              firstChunkPlayed = true;
              audioElement.src = blobUrl;
              setState((s) => ({ ...s, status: 'playing' }));
              await audioElement.play();
            } else {
              queueRef.current.push(blobUrl);
              if (audioElement.ended) playNext();
            }
          }

          if (event.type === 'done' && event.total !== undefined) {
            setState((s) => ({
              ...s,
              totalChunks: event.total ?? s.totalChunks,
            }));
          }
        }

        streamDoneRef.current = true;
        if (queueRef.current.length === 0 && (!firstChunkPlayed || audioElement.ended)) {
          setState((s) => ({ ...s, status: 'done' }));
        }
      } catch (err) {
        if (!abortRef.current?.signal.aborted) {
          setState((s) => ({
            ...s,
            status: 'error',
            error: err instanceof Error ? err.message : 'Stream failed',
          }));
        }
      }
    },
    [cleanup, playNext],
  );

  const pause = useCallback(() => {
    audioRef.current?.pause();
    setState((s) => ({ ...s, status: 'paused' }));
  }, []);

  const resume = useCallback(() => {
    audioRef.current?.play();
    setState((s) => ({ ...s, status: 'playing' }));
  }, []);

  const stop = useCallback(() => {
    cleanup();
    setState({ status: 'idle', currentIndex: 0, totalChunks: 0, progress: 0 });
  }, [cleanup]);

  return { state, start, pause, resume, stop };
}
