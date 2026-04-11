'use client';

import { useEffect, useRef, useState } from 'react';
import type { RichAudioBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';

/** CSS variable-based cat colors for voice message bars */
const CAT_VOICE_COLORS: Record<string, { bg: string; bar: string }> = {
  opus: { bg: 'bg-[var(--color-opus-bg)]', bar: 'bg-[var(--color-opus-primary)]' },
  codex: { bg: 'bg-[var(--color-codex-bg)]', bar: 'bg-[var(--color-codex-primary)]' },
  gemini: { bg: 'bg-[var(--color-gemini-bg)]', bar: 'bg-[var(--color-gemini-primary)]' },
  kimi: { bg: 'bg-[var(--color-kimi-bg)]', bar: 'bg-[var(--color-kimi-primary)]' },
};
const DEFAULT_VOICE_COLORS = { bg: 'bg-cafe-surface-elevated dark:bg-gray-800', bar: 'bg-gray-400' };

export function AudioBlock({ block, catId }: { block: RichAudioBlock; catId?: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const blobUrlRef = useRef<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [audioDuration, setAudioDuration] = useState(block.durationSec ?? 0);
  const [blobSrc, setBlobSrc] = useState<string | null>(null);

  const isVoiceMessage = !!block.text;

  // Fetch audio via apiFetch (carries auth header) → blob URL
  useEffect(() => {
    if (!block.url || !block.url.startsWith('/api/')) {
      if (block.url) setBlobSrc(block.url);
      return;
    }
    let cancelled = false;
    apiFetch(block.url)
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (!cancelled && blob) {
          const url = URL.createObjectURL(blob);
          blobUrlRef.current = url;
          setBlobSrc(url);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [block.url]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setPlaying(false);
      setProgress(0);
    };
    const onTimeUpdate = () => {
      if (audio.duration > 0) setProgress(audio.currentTime / audio.duration);
    };
    const onLoadedMetadata = () => {
      if (audio.duration > 0 && audio.duration < Infinity) {
        setAudioDuration(audio.duration);
      }
    };

    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
    };
  }, []);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      audio.play();
    }
  };

  const formatDuration = (sec: number) => {
    if (sec <= 0) return '';
    if (sec < 60) return `${Math.round(sec)}"`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // Voice message mode — WeChat-style voice bar
  if (isVoiceMessage) {
    const colors = (catId ? CAT_VOICE_COLORS[catId] : undefined) ?? DEFAULT_VOICE_COLORS;
    // Bar width scales with duration: min 80px, max 200px
    const barWidth = audioDuration > 0 ? Math.min(200, Math.max(80, 80 + audioDuration * 12)) : 120;

    return (
      <div className="space-y-0.5">
        <button
          onClick={toggle}
          className={`flex items-center gap-2 rounded-2xl px-3 py-1.5 transition-colors cursor-pointer ${colors.bg} hover:opacity-80`}
          style={{ width: `${barWidth}px` }}
          title={playing ? '暂停语音' : '播放语音'}
          aria-label={playing ? '暂停语音' : '播放语音'}
        >
          {/* Speaker / sound wave icon */}
          <span className="flex-shrink-0">
            {playing ? (
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

          {/* Progress dots / bar */}
          <div className="flex-1 flex items-center gap-[3px]">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className={`rounded-full transition-all duration-150 ${
                  playing && progress > i / 6 ? `h-3 ${colors.bar}` : `h-1.5 ${colors.bar} opacity-30`
                }`}
                style={{ width: '3px' }}
              />
            ))}
          </div>

          {/* Duration */}
          {audioDuration > 0 && (
            <span className="text-[11px] text-cafe-secondary dark:text-gray-400 flex-shrink-0 tabular-nums">
              {formatDuration(audioDuration)}
            </span>
          )}
        </button>

        {/* Voice text transcript */}
        <div className="text-[11px] text-cafe-muted dark:text-gray-500 pl-1 max-w-[420px] whitespace-pre-wrap break-words leading-relaxed">
          {block.text}
        </div>

        {blobSrc && <audio ref={audioRef} src={blobSrc} preload="metadata" />}
      </div>
    );
  }

  // Generic audio block mode (existing style)
  return (
    <div className="flex items-center gap-3 rounded-lg border border-cafe dark:border-gray-700 bg-cafe-surface-elevated dark:bg-gray-900/40 px-3 py-2">
      <button
        onClick={toggle}
        className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-500 hover:bg-blue-600 text-white flex items-center justify-center transition-colors"
        title={playing ? '暂停' : '播放'}
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? (
          <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
            <rect x="1" y="0" width="3" height="14" rx="1" />
            <rect x="8" y="0" width="3" height="14" rx="1" />
          </svg>
        ) : (
          <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
            <path d="M0 0L12 7L0 14V0Z" />
          </svg>
        )}
      </button>

      <div className="flex-1 min-w-0">
        {block.title && (
          <div className="text-xs font-medium text-cafe-secondary dark:text-gray-300 truncate">{block.title}</div>
        )}
        <div className="mt-1 h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-400 rounded-full transition-[width] duration-200"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      </div>

      {audioDuration > 0 && (
        <span className="text-[10px] text-cafe-muted flex-shrink-0 tabular-nums">{formatDuration(audioDuration)}</span>
      )}

      {blobSrc && <audio ref={audioRef} src={blobSrc} preload="none" />}
    </div>
  );
}
