'use client';
import type { ImmutableMedia } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReducedMediaMotion } from './gif-thumbnail';

type Clock = NonNullable<Extract<ImmutableMedia, { kind: 'image' }>['animation']>;
export function gifFrameTimestamp(clock: Clock, index: number) {
  return clock.frameDelaysMs.slice(0, index).reduce((sum, delay) => sum + delay, 0);
}
/** Browser-compatible zero-delay display floor; original delay values stay intact in the owner clock. */
export function gifDisplayClock(clock: Clock) {
  const starts: number[] = [];
  let duration = 0;
  for (const delay of clock.frameDelaysMs) {
    starts.push(duration);
    duration += delay === 0 ? 20 : delay;
  }
  return { starts, duration };
}
export function gifFrameAtTime(starts: number[], time: number) {
  let index = 0;
  while (index + 1 < starts.length && starts[index + 1] <= time) index++;
  return index;
}

/** One visible decoded frame and its exact original clock own selection, stepping and playback. */
export function useGifPlayback(src: string | null, media: ImmutableMedia, visible: boolean) {
  const clock = media.kind === 'image' ? media.animation : undefined;
  const active = !!clock && clock.frameCount > 1;
  const reducedMotion = useReducedMediaMotion();
  const [position, setPosition] = useState({ src, index: 0 });
  const [readySrc, setReadySrc] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [repeatOverride, setRepeat] = useState<boolean | null>(null);
  const repeat = repeatOverride ?? clock?.loopCount !== 1;
  const iterations = repeatOverride === true ? 0 : repeatOverride === false ? 1 : (clock?.loopCount ?? 1);
  const elapsed = useRef(0);
  const effective = useMemo(() => (clock ? gifDisplayClock(clock) : null), [clock]);
  const frameIndex = position.src === src ? position.index : 0;
  const ready = !!src && readySrc === src;
  const pause = useCallback(() => setPlaying(false), []);
  const loaded = useCallback(() => setReadySrc(src), [src]);
  useEffect(() => {
    elapsed.current = 0;
    setPosition({ src, index: 0 });
    setReadySrc(null);
    setRepeat(null);
  }, [src, active]);
  useEffect(() => {
    setPlaying(active && !reducedMotion);
  }, [src, active, reducedMotion]);
  useEffect(() => {
    if (!active || !clock || !effective || !playing || !visible || !ready) return;
    const started = performance.now() - elapsed.current / speed;
    let raf = 0;
    const advance = (now: number) => {
      const time = (now - started) * speed;
      elapsed.current = time;
      if (iterations > 0 && time >= effective.duration * iterations) {
        setPosition({ src, index: clock.frameCount - 1 });
        setPlaying(false);
        return;
      }
      const index = gifFrameAtTime(effective.starts, time % effective.duration);
      setPosition((current) => (current.src === src && current.index === index ? current : { src, index }));
      raf = requestAnimationFrame(advance);
    };
    raf = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(raf);
  }, [active, clock, effective, playing, ready, iterations, speed, src, visible]);
  const seek = (index: number) => {
    if (!clock || !effective) return;
    const next = Math.max(0, Math.min(clock.frameCount - 1, index));
    elapsed.current = effective.starts[next];
    setPosition({ src, index: next });
    setPlaying(false);
  };
  const toggle = () => {
    if (!ready || !effective || !clock) return;
    if (!playing && iterations > 0 && elapsed.current >= effective.duration * iterations) {
      elapsed.current = 0;
      setPosition({ src, index: 0 });
    }
    setPlaying((value) => !value);
  };
  return {
    active,
    clock,
    frameIndex,
    ready,
    playing,
    speed,
    repeat,
    pause,
    loaded,
    seek,
    toggle,
    setSpeed,
    setRepeat,
    frame: active && ready && clock ? { frameIndex, timestampMs: gifFrameTimestamp(clock, frameIndex) } : undefined,
  };
}
