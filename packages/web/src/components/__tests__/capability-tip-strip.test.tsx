import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import rawTips from '@/lib/capability-tips.seed.json';
import { recordCapabilityTipEvent } from '@/lib/capabilityTipEvents';
import { computeExposureScope, computeInventoryFingerprint } from '@/lib/capabilityTipExposure';
import { useConciergeStore } from '@/stores/conciergeStore';
import { CapabilityTipStrip } from '../CapabilityTipStrip';

vi.mock('@/lib/capabilityTipEvents', async () => ({
  recordCapabilityTipEvent: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;

type SeedTip = {
  id: string;
  contexts: string[];
  audience: string[];
  action?: { type?: string };
};

async function render(jsx: React.ReactNode) {
  await act(async () => {
    root.render(jsx);
    await Promise.resolve();
  });
}

describe('F244 CapabilityTipStrip', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useConciergeStore.setState({
      surfaceState: 'collapsed',
      pendingPrompt: null,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('shimmer placeholder has accessible status label (not hidden by aria-hidden)', async () => {
    await render(
      <CapabilityTipStrip
        surface="assistant_stream_bubble"
        contexts={['thinking']}
        firstDelayMs={6000}
        rotateMs={12000}
      />,
    );
    const strip = container.querySelector('[data-testid="capability-tip-strip"]');
    expect(strip).not.toBeNull();
    // The sr-only label must be a direct child of the status container,
    // NOT inside the aria-hidden skeleton — otherwise screen readers see nothing.
    const srOnly = strip?.querySelector('.sr-only');
    expect(srOnly).not.toBeNull();
    expect(srOnly?.textContent).toBe('猫猫思考中');
    // Must NOT be inside an aria-hidden ancestor
    expect(srOnly?.closest('[aria-hidden="true"]')).toBeNull();
  });

  it('shows container immediately with shimmer, then tip content after delay', async () => {
    await render(
      <CapabilityTipStrip
        surface="assistant_stream_bubble"
        contexts={['thinking']}
        firstDelayMs={6000}
        rotateMs={12000}
      />,
    );
    // Container renders immediately (with shimmer placeholder)
    expect(container.querySelector('[data-testid="capability-tip-strip"]')).not.toBeNull();
    // But no tip content yet (no "Tip" label, no "了解更多" button)
    expect(container.querySelector('[data-testid="capability-tip-learn-more"]')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    // After delay: tip content appears
    expect(container.querySelector('[data-testid="capability-tip-strip"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="capability-tip-learn-more"]')).not.toBeNull();
  });

  it('does not default omitted audience to all-only tips', async () => {
    const seedTips = rawTips as readonly SeedTip[];
    const scope = computeExposureScope('assistant_stream_bubble', undefined, ['review']);
    const allAudienceReviewTipIds = seedTips
      .filter(
        (tip) =>
          tip.action?.type === 'open_concierge_draft' &&
          tip.contexts.includes('review') &&
          tip.audience.includes('all'),
      )
      .map((tip) => tip.id);
    localStorage.setItem(
      `cat-cafe:tip-exposure:${scope}`,
      JSON.stringify({
        exposed: allAudienceReviewTipIds,
        firstSeen: {},
        fingerprint: computeInventoryFingerprint(seedTips.map((tip) => tip.id)),
      }),
    );

    await render(
      <CapabilityTipStrip surface="assistant_stream_bubble" contexts={['review']} firstDelayMs={0} rotateMs={12000} />,
    );
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    });

    const tipId = container.querySelector('[data-testid="capability-tip-strip"]')?.getAttribute('data-tip-id');
    const selectedTip = seedTips.find((tip) => tip.id === tipId);
    // All "all" review tips are pre-exposed above. Correct omitted-audience behavior
    // still has non-all tips available; an all-only default would fall back to exposed all tips.
    expect(selectedTip?.audience).not.toContain('all');
  });

  it('records the context that matched the selected tip', async () => {
    const recordCapabilityTipEventMock = vi.mocked(recordCapabilityTipEvent);

    await render(
      <CapabilityTipStrip
        surface="assistant_stream_bubble"
        contexts={['pet_waiting_for_user', 'long_running']}
        firstDelayMs={0}
        rotateMs={12000}
      />,
    );
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    });

    expect(recordCapabilityTipEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'capability_tip_exposed',
        context: 'long_running',
      }),
    );

    const button = container.querySelector('[data-testid="capability-tip-learn-more"]') as HTMLButtonElement | null;
    act(() => {
      button?.click();
    });

    expect(recordCapabilityTipEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'capability_tip_action',
        context: 'long_running',
      }),
    );
  });

  it('keeps each tip visible for at least 30 seconds', async () => {
    const recordCapabilityTipEventMock = vi.mocked(recordCapabilityTipEvent);

    await render(
      <CapabilityTipStrip
        surface="assistant_stream_bubble"
        contexts={['long_running']}
        firstDelayMs={0}
        rotateMs={12000}
      />,
    );
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    });

    expect(recordCapabilityTipEventMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(12000);
      await Promise.resolve();
    });

    expect(recordCapabilityTipEventMock).toHaveBeenCalledTimes(1);
  });

  it('starts rotation dwell after the first tip becomes visible', async () => {
    const recordCapabilityTipEventMock = vi.mocked(recordCapabilityTipEvent);

    await render(
      <CapabilityTipStrip
        surface="assistant_stream_bubble"
        contexts={['thinking', 'long_running']}
        firstDelayMs={6000}
        rotateMs={30000}
      />,
    );

    await act(async () => {
      vi.advanceTimersByTime(6000);
      await Promise.resolve();
    });
    expect(recordCapabilityTipEventMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(24000);
      await Promise.resolve();
    });

    expect(recordCapabilityTipEventMock).toHaveBeenCalledTimes(1);
  });

  it('clicking learn more opens concierge bubble with a draft and does not send', async () => {
    await render(
      <CapabilityTipStrip
        surface="assistant_stream_bubble"
        contexts={['thinking']}
        firstDelayMs={0}
        rotateMs={12000}
      />,
    );
    await act(async () => {
      vi.advanceTimersByTime(0);
    });

    const button = container.querySelector('[data-testid="capability-tip-learn-more"]') as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    expect(button?.getAttribute('title')).toContain('不会自动发送');

    act(() => {
      button?.click();
    });

    const state = useConciergeStore.getState();
    expect(state.surfaceState).toBe('bubble');
    expect(state.pendingPrompt).toContain('解释这个 tip');
    expect(state.pendingPrompt).toContain('tipId');
  });
});
