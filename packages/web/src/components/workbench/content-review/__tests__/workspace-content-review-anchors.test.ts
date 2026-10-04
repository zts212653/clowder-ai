import { expect, it } from 'vitest';
import { workspaceFrameAnchor } from '../workspace-content-review-anchors';

it('keeps ordinary video point and region comments on their presented frame, not the whole clip', () => {
  for (const frame of [
    { framePoint: { tick: 5120, x: 320, y: 180 } },
    { frameRegion: { tick: 5120, x: 320, y: 180, width: 80, height: 40 } },
  ]) {
    expect(
      workspaceFrameAnchor({ kind: 'video-range', streamId: '0:video', startTick: 0, endTick: 38400, ...frame }),
    ).toEqual({ kind: 'video-range', streamId: '0:video', startTick: 5120, endTick: 5121, ...frame });
  }
});

it('retains canonical image coordinates and explicitly selected ranges', () => {
  const image = { kind: 'image-region' as const, x: 10, y: 20, width: 100, height: 80 };
  const range = { kind: 'video-range' as const, streamId: '0:video', startTick: 0, endTick: 12800 };
  expect(workspaceFrameAnchor(image)).toBe(image);
  expect(workspaceFrameAnchor(range)).toBe(range);
});
