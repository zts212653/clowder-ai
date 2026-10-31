'use client';
import type { ImmutableMedia } from '@cat-cafe/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { tickToBrowserTime } from '../review-geometry';

export interface ComparePlaybackAlignment {
  driver: 0 | 1;
  position(elapsed: number, index: number): { seconds: number; rateScale: number } | null;
}
export function useComparePlayback(media: readonly ImmutableMedia[], alignment?: ComparePlaybackAlignment) {
  const videos = useRef<(HTMLVideoElement | null)[]>([null, null]);
  const refs = useMemo(
    () =>
      [0, 1].map((index) => (element: HTMLVideoElement | null) => {
        if (!element) videos.current[index]?.pause();
        videos.current[index] = element;
      }),
    [],
  );
  const [ready, setReady] = useState(false),
    [playing, setPlaying] = useState(false);
  const [seconds, setSeconds] = useState(0),
    [error, setError] = useState<string | null>(null);
  const [rate, setPlaybackRate] = useState(1);
  const generation = useRef(0);
  const clocks = media.map((item) =>
    item.kind === 'video'
      ? {
          start: tickToBrowserTime(item.startTick, item),
          duration: tickToBrowserTime(item.durationTicks, item),
        }
      : { start: 0, duration: 0 },
  );
  const driver = alignment?.driver ?? (clocks[1].duration >= clocks[0].duration ? 1 : 0);
  const duration = alignment ? clocks[driver].duration : Math.max(...clocks.map((item) => item.duration));
  const position = (elapsed: number, index: number) =>
    alignment
      ? alignment.position(elapsed, index)
      : { seconds: clocks[index].start + Math.min(elapsed, clocks[index].duration), rateScale: 1 };
  const applyRate = (video: HTMLVideoElement, index: number, elapsed: number, selectedRate = rate) => {
    const target = position(elapsed, index);
    if (!target) {
      video.pause();
      return null;
    }
    try {
      video.playbackRate = selectedRate * target.rateScale;
    } catch {
      video.pause();
      setError('此版本无法按对应速度播放，请调整速度或重新打开对比。');
      return null;
    }
    return target;
  };
  const pause = () => {
    generation.current += 1;
    videos.current.forEach((video) => {
      video?.pause();
    });
    setPlaying(false);
  };
  const resumeWithinRange = (video: HTMLVideoElement, index: number, elapsed: number) => {
    if (video.ended) return;
    if (!playing) return;
    const target = applyRate(video, index, elapsed);
    if (!target || target.seconds >= clocks[index].start + clocks[index].duration) {
      video.pause();
      return;
    }
    if (!video.paused) return;
    const attempt = generation.current;
    void video.play().then(
      () => {
        if (attempt !== generation.current) video.pause();
      },
      () => {
        if (attempt === generation.current) {
          pause();
          setError('同步播放无法继续，请重试。');
        }
      },
    );
  };
  const seek = (elapsed: number) => {
    const next = Math.max(0, Math.min(duration, elapsed));
    videos.current.forEach((video, index) => {
      if (!video?.readyState) return;
      const target = applyRate(video, index, next);
      if (!target) return;
      video.currentTime = target.seconds;
      resumeWithinRange(video, index, next);
    });
    setSeconds(next);
  };
  const loaded = (index: number) => {
    const video = videos.current[index];
    const target = video ? applyRate(video, index, seconds) : null;
    if (video && target) video.currentTime = target.seconds;
    setReady(videos.current.every((item) => item !== null && item.readyState >= 1));
  };
  const play = async () => {
    if (!ready) return;
    if (playing) {
      pause();
      return;
    }
    const elapsed = seconds >= duration ? 0 : seconds;
    if (seconds >= duration) seek(0);
    const attempt = ++generation.current;
    setError(null);
    try {
      await Promise.all(
        videos.current.map((video, index) => {
          const target = video ? applyRate(video, index, elapsed) : null;
          if (!target || target.seconds >= clocks[index].start + clocks[index].duration) {
            video?.pause();
            return Promise.resolve();
          }
          return video?.play();
        }),
      );
      if (attempt === generation.current) setPlaying(true);
      else
        videos.current.forEach((video) => {
          video?.pause();
        });
    } catch {
      if (attempt === generation.current) {
        pause();
        setError('同步播放未能开始，请重试。');
      }
    }
  };
  const timeUpdate = (index: number) => {
    const leader = videos.current[index];
    if (index !== driver || !leader) return;
    const elapsed = Math.max(0, leader.currentTime - clocks[index].start);
    setSeconds(Math.min(duration, elapsed));
    videos.current.forEach((video, other) => {
      if (!video || other === index || !video.readyState || video.seeking) return;
      const target = applyRate(video, other, elapsed);
      if (!target) return;
      if (Math.abs(video.currentTime - target.seconds) > 0.08) video.currentTime = target.seconds;
      resumeWithinRange(video, other, elapsed);
    });
    if (elapsed >= duration) pause();
  };
  useEffect(
    () => () => {
      generation.current += 1;
      videos.current.forEach((video) => {
        video?.pause();
      });
    },
    [],
  );
  return {
    videos,
    refs,
    ready,
    playing,
    seconds,
    duration,
    rate,
    setRate: (next: number) => {
      if (!Number.isFinite(next) || next <= 0) return;
      setPlaybackRate(next);
      videos.current.forEach((video, index) => {
        if (video) applyRate(video, index, seconds, next);
      });
    },
    error,
    play,
    seek,
    loaded,
    timeUpdate,
    ended: (index: number) => {
      if (index === driver) {
        pause();
        setSeconds(duration);
      }
    },
    failed: () => {
      pause();
      setReady(false);
      setError('视频当前无法播放，请重新打开对比。');
    },
    differentLengths: Math.abs(clocks[0].duration - clocks[1].duration) > 0.01,
  };
}
