import { describe, expect, it, vi } from 'vitest';
import { ballIntersectsReservedRect, resolveBallPosition } from '../ball-position';
import { readConciergeReservedRects } from '../concierge-reserved-rects';
import { computeAmbientBehavior } from '../petBehaviorCore';

describe('concierge host collision contract', () => {
  it('moves a displayed ball to the nearest legal position outside a host reservation', () => {
    const reserved = { left: 1_280, top: 720, right: 1_440, bottom: 960 };
    const resolved = resolveBallPosition(
      { x: 1_320, y: 760 },
      {
        viewport: { width: 1_440, height: 960 },
        ballSize: 72,
        edgeMargin: 24,
        toolbarBelow: 44,
        reservedRects: [reserved],
      },
    );

    expect(ballIntersectsReservedRect(resolved, 72, reserved)).toBe(false);
    expect(resolved).toEqual({ x: 1_184, y: 760 });
  });

  it('keeps repeated autonomous walk candidates outside the same host reservation', () => {
    const reserved = { left: 120, top: 80, right: 220, bottom: 180 };
    let ballPosition = { x: 40, y: 100 };
    for (let step = 0; step < 16; step += 1) {
      const result = computeAmbientBehavior({
        autonomousElapsedMs: 40_000 + step,
        currentTimestamp: 40_000 + step,
        userIdleSinceMs: 0,
        mouseDistance: 999,
        lastWalkEndTimestamp: 0,
        walkSeed: (step % 8) * 0.035,
        viewport: { width: 500, height: 400 },
        ballPosition,
        ballSize: 72,
        edgeMargin: 24,
        toolbarBelow: 44,
        reservedRects: [reserved],
      });
      if (result.positionDelta) {
        ballPosition = {
          x: ballPosition.x + result.positionDelta.dx,
          y: ballPosition.y + result.positionDelta.dy,
        };
      }
      expect(ballIntersectsReservedRect(ballPosition, 72, reserved)).toBe(false);
    }
  });

  it('reads only non-empty product-declared DOM reservations', () => {
    const root = document.createElement('div');
    const active = document.createElement('div');
    active.dataset.conciergeReservedRect = 'collective-message-actions';
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 200,
      right: 356,
      bottom: 400,
      width: 256,
      height: 200,
      x: 100,
      y: 200,
      toJSON: () => ({}),
    });
    const empty = document.createElement('div');
    empty.dataset.conciergeReservedRect = 'empty';
    root.append(active, empty);

    expect(readConciergeReservedRects(root)).toEqual([{ left: 100, top: 200, right: 356, bottom: 400 }]);
  });
});
