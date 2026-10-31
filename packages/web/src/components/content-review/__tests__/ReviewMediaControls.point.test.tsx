import type { ArtifactReviewAnchor, ImmutableMedia } from '@cat-cafe/shared';
import { act, createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ReviewMediaControls } from '../ReviewMediaControls';

it('range adjustment retains an included video point and removes a point outside the new half-open range', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const media: ImmutableMedia = {
    kind: 'video',
    width: 800,
    height: 600,
    codedWidth: 800,
    codedHeight: 600,
    rotation: 0,
    pixelAspectRatio: { numerator: 1, denominator: 1 },
    streamId: 'video',
    streamIndex: 0,
    timebase: { numerator: 1, denominator: 100 },
    startTick: 0,
    durationTicks: 400,
    containerStartSeconds: 0,
  };
  const selected: ArtifactReviewAnchor = {
    kind: 'video-range',
    streamId: 'video',
    startTick: 0,
    endTick: 400,
    framePoint: { tick: 100, x: 250, y: 150 },
  };
  const onSelect = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(ReviewMediaControls, {
          media,
          round: 1,
          selected,
          canAnnotate: true,
          src: 'blob:video',
          error: null,
          selectionActive: false,
          selecting: false,
          showSelectionControls: true,
          frameTime: 1,
          seconds: 1,
          videoRef: createRef<HTMLVideoElement>(),
          onSelect,
          onSelectingChange: vi.fn(),
        }),
      ),
    );
    const end = container.querySelector<HTMLInputElement>('[aria-label="片段终点"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(end, '3');
      end.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onSelect).toHaveBeenLastCalledWith({ ...selected, endTick: 300 });
    await act(async () => {
      setValue.call(end, '1');
      end.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onSelect).toHaveBeenLastCalledWith({ kind: 'video-range', streamId: 'video', startTick: 0, endTick: 100 });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
