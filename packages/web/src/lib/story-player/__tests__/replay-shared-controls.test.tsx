/**
 * F314-14: thread replay (useReplayEngine) and feature replay (useFeatureReplay)
 * share one keyboard hook and one RAF clock. Drives the shared hooks directly.
 */
import { act, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReplayEngine, play } from '../replay-engine';
import type { ReplayEngineState, ReplayEvent } from '../types';
import { useReplayKeyboard, useReplayTick } from '../useReplayEngine';

const events: ReplayEvent[] = Array.from({ length: 5 }, (_, i) => ({
  index: i,
  type: 'message',
  role: 'assistant',
  content: '',
  eventNo: i,
  timestamp: i * 10_000,
}));

let latest: ReplayEngineState;
function Harness({ playing }: { playing?: boolean }) {
  const [engine, setEngine] = useState(() => (playing ? play(createReplayEngine(events)) : createReplayEngine(events)));
  const engineRef = useRef(engine);
  engineRef.current = engine;
  useReplayTick(setEngine, engineRef);
  useReplayKeyboard(setEngine);
  useEffect(() => {
    latest = engine;
  });
  return <input aria-label="note" />;
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const press = (key: string, target: EventTarget = window) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });

describe('shared replay controls (F314-14)', () => {
  it('Space toggles play and pause, arrows step through events', async () => {
    await act(async () => root.render(<Harness />));
    expect(latest.state).not.toBe('playing');
    press(' ');
    expect(latest.state).toBe('playing');
    press(' ');
    expect(latest.state).not.toBe('playing');

    const start = latest.currentIndex;
    press('ArrowRight');
    expect(latest.currentIndex).toBe(start + 1);
    press('ArrowLeft');
    expect(latest.currentIndex).toBe(start);
  });

  it('ignores keys typed into a form field', async () => {
    await act(async () => root.render(<Harness />));
    const input = container.querySelector('input');
    if (!input) throw new Error('Missing input');
    press(' ', input);
    press('ArrowRight', input);
    expect(latest.state).not.toBe('playing');
    expect(latest.currentIndex).toBe(createReplayEngine(events).currentIndex);
  });

  it('advances elapsed time from animation frames only while playing', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    await act(async () => root.render(<Harness playing />));
    const runFrame = (t: number) => act(() => frames.shift()?.(t));
    runFrame(1000);
    runFrame(1500);
    expect(latest.elapsedMs).toBeGreaterThan(0);
  });

  it('keeps elapsed time still while paused', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    await act(async () => root.render(<Harness />));
    const runFrame = (t: number) => act(() => frames.shift()?.(t));
    runFrame(1000);
    runFrame(1500);
    expect(latest.elapsedMs).toBe(0);
  });
});
