'use client';

import type { TtsStreamRequest } from '@cat-cafe/shared';
import { useEffect, useRef } from 'react';
import { useStreamingAudio } from '@/hooks/useStreamingAudio';

const CAT_VOICE_COLORS: Record<string, { bg: string; bar: string }> = {
  opus: { bg: 'bg-[var(--color-opus-bg)]', bar: 'bg-[var(--color-opus-primary)]' },
  codex: { bg: 'bg-[var(--color-codex-bg)]', bar: 'bg-[var(--color-codex-primary)]' },
  gemini: { bg: 'bg-[var(--color-gemini-bg)]', bar: 'bg-[var(--color-gemini-primary)]' },
  kimi: { bg: 'bg-[var(--color-kimi-bg)]', bar: 'bg-[var(--color-kimi-primary)]' },
};
const DEFAULT_VOICE_COLORS = { bg: 'bg-cafe-surface-elevated dark:bg-gray-800', bar: 'bg-gray-400' };

interface Props {
  request: TtsStreamRequest;
  catId?: string;
  autoPlay?: boolean;
}

export function StreamingAudioBlock({ request, catId, autoPlay = true }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const { state, start, pause, resume, stop } = useStreamingAudio();
  const startedRef = useRef(false);

  useEffect(() => {
    if (autoPlay && audioRef.current && !startedRef.current) {
      startedRef.current = true;
      start(request, audioRef.current);
    }
    return () => {
      stop();
    };
  }, [autoPlay, request, start, stop]);

  const toggle = () => {
    if (state.status === 'playing') {
      pause();
    } else if (state.status === 'paused') {
      resume();
    } else if (state.status === 'done' && audioRef.current) {
      startedRef.current = true;
      start(request, audioRef.current);
    }
  };

  const isPlaying = state.status === 'playing';
  const isLoading = state.status === 'loading';
  const colors = (catId ? CAT_VOICE_COLORS[catId] : undefined) ?? DEFAULT_VOICE_COLORS;

  const formatChunkInfo = () => {
    if (state.totalChunks <= 0) return '';
    return `${state.currentIndex + 1}/${state.totalChunks}`;
  };

  return (
    <div className="space-y-0.5">
      <button
        onClick={toggle}
        disabled={isLoading}
        className={`flex items-center gap-2 rounded-2xl px-3 py-1.5 transition-colors cursor-pointer ${colors.bg} hover:opacity-80 ${isLoading ? 'opacity-50' : ''}`}
        style={{ width: '160px' }}
        title={isPlaying ? '暂停' : isLoading ? '加载中...' : '播放'}
        aria-label={isPlaying ? '暂停' : isLoading ? '加载中' : '播放'}
      >
        <span className="flex-shrink-0">
          {isLoading ? (
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="animate-spin opacity-50"
            >
              <circle cx="12" cy="12" r="10" strokeDasharray="40" strokeDashoffset="10" />
            </svg>
          ) : isPlaying ? (
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="opacity-70"
            >
              <path d="M11 5L6 9H2v6h4l5 4V5z" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14" className="animate-pulse" />
            </svg>
          ) : (
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="opacity-50"
            >
              <path d="M11 5L6 9H2v6h4l5 4V5z" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            </svg>
          )}
        </span>

        <div className="flex-1 h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-[width] duration-200 ${colors.bar}`}
            style={{ width: `${Math.min(state.progress * 100, 100)}%` }}
          />
        </div>

        {state.totalChunks > 0 && (
          <span className="text-[10px] text-cafe-muted flex-shrink-0 tabular-nums">{formatChunkInfo()}</span>
        )}
      </button>

      {request.text && (
        <div className="text-[11px] text-cafe-muted dark:text-gray-500 pl-1 max-w-[420px] whitespace-pre-wrap break-words leading-relaxed">
          {request.text}
        </div>
      )}

      {state.status === 'error' && <div className="text-[11px] text-red-400 pl-1">{state.error}</div>}

      <audio ref={audioRef} preload="none" />
    </div>
  );
}
