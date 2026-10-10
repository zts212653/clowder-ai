import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DemoScenes } from '../DemoScenes';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it('moves between scenes without changing hook order or leaving stale advance timers', async () => {
  const advance = vi.fn();
  const update = vi.fn();
  const render = async (scene: number, paused = false) => {
    await act(async () =>
      root.render(
        <DemoScenes scene={scene} demoScene={scene} paused={paused} onAdvance={advance} onUpdateDemo={update} />,
      ),
    );
  };
  await render(1);
  await act(async () => vi.advanceTimersByTime(3000));
  expect(advance).not.toHaveBeenCalled();
  await render(2);
  await act(async () => vi.advanceTimersByTime(30));
  expect(host.querySelector('textarea')?.value).toBe('帮');
  await render(2, true);
  await act(async () => vi.advanceTimersByTime(3000));
  expect(host.querySelector('textarea')?.value).toBe('帮');
  await render(3);
  await act(async () => vi.advanceTimersByTime(1000));
  await render(4);
  await act(async () => vi.advanceTimersByTime(800));
  expect(advance).not.toHaveBeenCalled();
  await render(4, true);
  await act(async () => vi.advanceTimersByTime(3000));
  expect(advance).not.toHaveBeenCalled();
  await render(4);
  await act(async () => vi.advanceTimersByTime(2200));
  expect(advance).toHaveBeenCalledExactlyOnceWith(5);
  await render(5);
  await act(async () => vi.advanceTimersByTime(3000));
  expect(advance).toHaveBeenCalledTimes(1);
});
