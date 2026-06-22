import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { REVIEW_STREAMING_TIP_CONTEXTS } from '@/components/capability-tip-placement';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: () => ({
      id: 'opus',
      displayName: '布偶猫',
      variantLabel: 'Opus 4.6',
      breedId: 'ragdoll',
      clientId: 'anthropic',
      defaultModel: 'claude-opus-4-6',
      avatar: '/avatars/opus.png',
      mentionPatterns: ['@opus'],
      roleDescription: '',
      personality: '',
      color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
    }),
  }),
  formatCatName: (cat: { displayName: string; variantLabel?: string }) =>
    cat.variantLabel ? `${cat.displayName}（${cat.variantLabel}）` : cat.displayName,
}));

vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: () => React.createElement('span', { 'data-testid': 'cat-avatar' }, 'avatar'),
}));

describe('F244 PendingMemberBubble capability tips', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders capability tip strip immediately as the thinking indicator (no separate dots)', async () => {
    const { PendingMemberBubble } = await import('@/components/PendingMemberBubble');

    await act(async () => {
      root.render(
        React.createElement(PendingMemberBubble, {
          catId: 'opus',
          invocationId: 'inv-001',
          showCapabilityTip: true,
        }),
      );
      await Promise.resolve();
    });

    const bubble = container.querySelector('[data-message-id="pending-inv-001"]');
    expect(bubble).not.toBeNull();
    // Tip strip IS the thinking indicator — renders immediately, no delay
    expect(bubble?.querySelector('[data-testid="capability-tip-strip"]')).not.toBeNull();
    // No separate bouncing dots when tip is the thinking indicator
    expect(bubble?.querySelectorAll('.animate-bounce').length).toBe(0);
  });

  it('tip strip has thinking animation class', async () => {
    const { PendingMemberBubble } = await import('@/components/PendingMemberBubble');

    await act(async () => {
      root.render(
        React.createElement(PendingMemberBubble, {
          catId: 'opus',
          invocationId: 'inv-002',
          showCapabilityTip: true,
        }),
      );
      await Promise.resolve();
    });

    const strip = container.querySelector('[data-testid="capability-tip-strip"]');
    expect(strip).not.toBeNull();
    expect(strip?.classList.contains('tip-thinking')).toBe(true);
  });

  it.each([
    'suspected_stall',
    'alive_but_silent',
  ] as const)('falls back to dots when cat status is %s (AC-B2 stall red line)', async (status) => {
    const { PendingMemberBubble } = await import('@/components/PendingMemberBubble');

    await act(async () => {
      root.render(
        React.createElement(PendingMemberBubble, {
          catId: 'opus',
          invocationId: 'inv-stall',
          catStatus: status,
          showCapabilityTip: true,
        }),
      );
      await Promise.resolve();
    });

    const bubble = container.querySelector('[data-message-id="pending-inv-stall"]');
    // Stall suppresses tip strip → falls back to dots
    expect(bubble?.querySelector('[data-testid="capability-tip-strip"]')).toBeNull();
    expect(bubble?.querySelectorAll('.animate-bounce').length).toBe(3);
  });

  it('shows dots when showCapabilityTip is false (dedup fallback)', async () => {
    const { PendingMemberBubble } = await import('@/components/PendingMemberBubble');

    await act(async () => {
      root.render(
        React.createElement(PendingMemberBubble, {
          catId: 'opus',
          invocationId: 'inv-no-tip',
          showCapabilityTip: false,
        }),
      );
      await Promise.resolve();
    });

    const bubble = container.querySelector('[data-message-id="pending-inv-no-tip"]');
    // Dedup bubbles get dots, not tip strip
    expect(bubble?.querySelectorAll('.animate-bounce').length).toBe(3);
    expect(bubble?.querySelector('[data-testid="capability-tip-strip"]')).toBeNull();
  });

  it('uses review contexts when tipContexts are provided', async () => {
    const { PendingMemberBubble } = await import('@/components/PendingMemberBubble');

    await act(async () => {
      root.render(
        React.createElement(PendingMemberBubble, {
          catId: 'opus',
          invocationId: 'inv-review',
          tipContexts: REVIEW_STREAMING_TIP_CONTEXTS,
          showCapabilityTip: true,
        }),
      );
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(1500);
      await Promise.resolve();
    });

    // Tip strip renders (review contexts still match some tips)
    const bubble = container.querySelector('[data-message-id="pending-inv-review"]');
    expect(bubble?.querySelector('[data-testid="capability-tip-strip"]')).not.toBeNull();
  });
});
