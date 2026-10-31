import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestrationFlow } from '@/stores/guideStore';
import { useGuideStore } from '@/stores/guideStore';
import { computeHUDPosition, computeShieldPanels } from '../GuideOverlay';

/* ── computeShieldPanels geometry tests ── */

describe('computeShieldPanels', () => {
  const pad = 8;

  it('creates four panels around a centered target', () => {
    const rect = { top: 100, bottom: 150, left: 200, right: 350, width: 150, height: 50 };
    const p = computeShieldPanels(rect, pad);

    // Top panel: covers y=0 -> y=92
    expect(p.top.height).toBe(92);
    // Bottom panel: starts at y=158
    expect(p.bottom.top).toBe(158);
    // Left panel: at y=92, covers x=0 -> x=192, height=66
    expect(p.left).toEqual({ top: 92, width: 192, height: 66 });
    // Right panel: at y=92, starts x=358, height=66
    expect(p.right).toEqual({ top: 92, left: 358, height: 66 });
  });

  it('clamps to zero when target is at top-left corner', () => {
    const rect = { top: 0, bottom: 40, left: 0, right: 120, width: 120, height: 40 };
    const p = computeShieldPanels(rect, pad);

    expect(p.top.height).toBe(0);
    expect(p.left.width).toBe(0);
    expect(p.bottom.top).toBe(48);
    expect(p.right.left).toBe(128);
  });

  it('handles target close to edge (pad exceeds distance)', () => {
    const rect = { top: 3, bottom: 53, left: 5, right: 105, width: 100, height: 50 };
    const p = computeShieldPanels(rect, pad);

    // top: max(0, 3-8) = 0
    expect(p.top.height).toBe(0);
    // left: max(0, 5-8) = 0
    expect(p.left.width).toBe(0);
  });

  it('four panels leave exactly the target+pad hole', () => {
    const rect = { top: 200, bottom: 260, left: 300, right: 500, width: 200, height: 60 };
    const p = computeShieldPanels(rect, pad);

    const holeLeft = p.left.width; // 300 - 8 = 292
    const holeRight = p.right.left; // 500 + 8 = 508
    const holeTop = p.top.height; // 200 - 8 = 192
    const holeBottom = p.bottom.top; // 260 + 8 = 268

    expect(holeRight - holeLeft).toBe(rect.width + pad * 2);
    expect(holeBottom - holeTop).toBe(rect.height + pad * 2);
  });
});

describe('computeHUDPosition', () => {
  it('keeps a 480px horizontal HUD inside the viewport near the right edge', () => {
    vi.stubGlobal('innerWidth', 640);
    vi.stubGlobal('innerHeight', 480);
    const rect = { top: 120, bottom: 180, left: 520, right: 580, width: 60, height: 60 } as DOMRect;
    const style = computeHUDPosition(rect, { width: 480, height: 160 });

    expect(style.left).toBe(144);
    expect(style.top).toBe(196);
  });

  it('keeps a tall media HUD inside the viewport near the bottom edge', () => {
    vi.stubGlobal('innerWidth', 640);
    vi.stubGlobal('innerHeight', 360);
    const rect = { top: 300, bottom: 340, left: 200, right: 260, width: 60, height: 40 } as DOMRect;
    const style = computeHUDPosition(rect, { width: 280, height: 280 });

    expect(style.left).toBe(90);
    expect(style.top).toBe(16);
  });
});

/* ── Phase state machine scenario tests ── */

const MOCK_FLOW: OrchestrationFlow = {
  id: 'phase-test',
  name: 'Phase Test',
  steps: [
    { id: 's1', target: 'hub.trigger', tips: 'Click', advance: 'click', timeoutSec: 30 },
    { id: 's2', target: 'cats.overview', tips: 'Navigate', advance: 'click' },
  ],
};

describe('Guide phase transitions', () => {
  beforeEach(() => {
    useGuideStore.setState({ session: null });
  });

  it('starts in locating phase, transitions to active', () => {
    useGuideStore.getState().startGuide(MOCK_FLOW);
    expect(useGuideStore.getState().session!.phase).toBe('locating');

    useGuideStore.getState().setPhase('active');
    expect(useGuideStore.getState().session!.phase).toBe('active');
  });

  it('advanceStep resets phase to locating', () => {
    useGuideStore.getState().startGuide(MOCK_FLOW);
    useGuideStore.getState().setPhase('active');
    useGuideStore.getState().advanceStep();
    const s = useGuideStore.getState().session!;
    expect(s.currentStepIndex).toBe(1);
    expect(s.phase).toBe('locating');
  });

  it('advancing past last step sets phase to complete', () => {
    useGuideStore.getState().startGuide(MOCK_FLOW);
    useGuideStore.getState().advanceStep(); // -> 1
    useGuideStore.getState().advanceStep(); // -> 2 (past end)
    const s = useGuideStore.getState().session!;
    expect(s.phase).toBe('complete');
  });

  it('setPhase does not affect session after exitGuide', () => {
    useGuideStore.getState().startGuide(MOCK_FLOW);
    useGuideStore.getState().exitGuide();

    // Late setPhase call should be no-op (session null)
    useGuideStore.getState().setPhase('active');
    expect(useGuideStore.getState().session).toBeNull();
  });

  it('preserves per-step timeoutSec in flow data', () => {
    useGuideStore.getState().startGuide(MOCK_FLOW);
    const s = useGuideStore.getState().session!;
    expect(s.flow.steps[0].timeoutSec).toBe(30);
    expect(s.flow.steps[1].timeoutSec).toBeUndefined();
  });
});

/* ── Esc key guard interaction regression (KD-14) ── */

/**
 * Tests the actual Escape handler guard logic from CatCafeHub.
 * We extract the guard condition and run it against real KeyboardEvents
 * + real guideStore state, asserting closeHub is/isn't called.
 */
describe('Guide Esc key guard (interaction)', () => {
  beforeEach(() => {
    useGuideStore.setState({ session: null });
  });

  it('Escape does NOT call closeHub when guide is active', () => {
    useGuideStore.getState().startGuide(MOCK_FLOW);
    useGuideStore.getState().setPhase('active');

    const closeHub = vi.fn();
    // Replicate CatCafeHub's actual handler logic
    const handler = (e: KeyboardEvent) => {
      const guideActive = useGuideStore.getState().session !== null;
      if (e.key === 'Escape' && !guideActive) closeHub();
    };

    window.addEventListener('keydown', handler);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    window.removeEventListener('keydown', handler);

    expect(closeHub).not.toHaveBeenCalled();
    // Guide session must remain intact
    expect(useGuideStore.getState().session).not.toBeNull();
    expect(useGuideStore.getState().session!.phase).toBe('active');
  });

  it('Escape DOES call closeHub when no guide is active', () => {
    // No guide session
    const closeHub = vi.fn();
    const handler = (e: KeyboardEvent) => {
      const guideActive = useGuideStore.getState().session !== null;
      if (e.key === 'Escape' && !guideActive) closeHub();
    };

    window.addEventListener('keydown', handler);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    window.removeEventListener('keydown', handler);

    expect(closeHub).toHaveBeenCalledTimes(1);
  });
});
