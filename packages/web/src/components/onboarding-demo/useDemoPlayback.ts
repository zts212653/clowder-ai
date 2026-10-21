'use client';

import { useEffect, useRef, useState } from 'react';
import { DEMO_EVENTS } from './demo-story';
import { reportOnboardingTiming } from './onboarding-performance';

interface Playback {
  version: 1;
  index: number;
  paused: boolean;
}
const initial: Playback = { version: 1, index: -1, paused: true };

// This is a browser-local demo bookmark, not an account's onboarding completion.
export function useDemoPlayback(scope: string) {
  const key = `cat-cafe:scripted-onboarding:v1:${scope}`;
  const [state, setState] = useState<Playback>(initial);
  const [ready, setReady] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const elapsed = useRef(0);
  const lastIndex = useRef(-1);
  useEffect(() => {
    let index = 0;
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
      if (
        saved &&
        typeof saved === 'object' &&
        'version' in saved &&
        saved.version === 1 &&
        'index' in saved &&
        typeof saved.index === 'number' &&
        Number.isInteger(saved.index) &&
        saved.index >= -1 &&
        saved.index <= DEMO_EVENTS.length
      ) {
        index = saved.index < DEMO_EVENTS.length ? Math.max(0, saved.index) : 0;
      }
    } catch {
      /* Storage is optional; the demo also works in private browsing. */
    }
    // Opening the demo is the user's start/continue action; a completed
    // bookmark replays without requiring another click.
    setState({ version: 1, index, paused: false });
    setReady(true);
  }, [key]);
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      /* No persistence required. */
    }
  }, [key, ready, state]);
  useEffect(() => {
    const event = DEMO_EVENTS[state.index];
    if (lastIndex.current !== state.index) {
      elapsed.current = 0;
      setElapsedMs(0);
      lastIndex.current = state.index;
    }
    if (!ready || state.paused || !event) return;
    const scheduledAt = performance.now();
    const previousElapsed = elapsed.current;
    const progress = setInterval(() => {
      elapsed.current = previousElapsed + performance.now() - scheduledAt;
      setElapsedMs(elapsed.current);
    }, 50);
    const timer = setTimeout(
      () => {
        const elapsed = performance.now() - scheduledAt;
        reportOnboardingTiming('demo-step', {
          step: event.id,
          plannedMs: event.duration,
          elapsedMs: Math.round(elapsed),
          lateMs: Math.round(Math.max(0, elapsed - event.duration)),
        });
        setState((current) => ({ ...current, index: current.index + 1 }));
      },
      Math.max(0, event.duration - previousElapsed),
    );
    return () => {
      elapsed.current = previousElapsed + performance.now() - scheduledAt;
      clearInterval(progress);
      clearTimeout(timer);
    };
  }, [ready, state.index, state.paused]);
  const event = DEMO_EVENTS[state.index];
  const isCat = event && event.speaker !== 'user' && event.speaker !== 'system';
  // A state.index change renders once before the effect resets elapsedMs. Treat
  // that boundary as the new event's zero point so the previous event's final
  // elapsed value cannot briefly expose the full next response.
  const effectiveElapsedMs = lastIndex.current === state.index ? elapsedMs : 0;
  const thinkingMs = 900;
  const typingMs = event ? Math.min(2400, Math.max(1000, event.text.length * 28)) : 0;
  const phase: 'complete' | 'thinking' | 'typing' =
    !isCat || effectiveElapsedMs >= thinkingMs + typingMs
      ? 'complete'
      : effectiveElapsedMs < thinkingMs
        ? 'thinking'
        : 'typing';
  const characters =
    event && isCat
      ? Math.min(
          event.text.length,
          Math.floor((Math.max(0, effectiveElapsedMs - thinkingMs) / typingMs) * event.text.length),
        )
      : (event?.text.length ?? 0);
  return {
    ...state,
    phase,
    characters,
    ready,
    finished: state.index === DEMO_EVENTS.length,
    start: () => setState({ version: 1, index: 0, paused: false }),
    toggle: () => setState((current) => ({ ...current, paused: !current.paused })),
  };
}
