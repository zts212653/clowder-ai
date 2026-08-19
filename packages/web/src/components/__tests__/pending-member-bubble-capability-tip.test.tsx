import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: () => ({
      id: 'opus',
      displayName: '布偶猫',
      variantLabel: 'Opus 4.6',
      color: { primary: '#9B7EBD' },
    }),
  }),
  formatCatName: (cat: { displayName: string; variantLabel?: string }) =>
    cat.variantLabel ? `${cat.displayName}（${cat.variantLabel}）` : cat.displayName,
}));

vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: () => React.createElement('span', { 'data-testid': 'cat-avatar' }, 'avatar'),
}));

describe('PendingMemberBubble capability tips', () => {
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

  it('shows the cat identity and tip during the pre-output wait', async () => {
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
    expect(bubble?.querySelector('[data-testid="cat-avatar"]')).not.toBeNull();
    expect(bubble?.querySelector('[data-testid="capability-tip-strip"]')).not.toBeNull();
    expect(bubble?.querySelectorAll('.animate-bounce').length).toBe(0);
  });

  it.each([
    'suspected_stall',
    'alive_but_silent',
  ] as const)('suppresses the tip and keeps minimal dots when status is %s', async (catStatus) => {
    const { PendingMemberBubble } = await import('@/components/PendingMemberBubble');

    await act(async () => {
      root.render(
        React.createElement(PendingMemberBubble, {
          catId: 'opus',
          invocationId: 'inv-stall',
          catStatus,
          showCapabilityTip: true,
        }),
      );
      await Promise.resolve();
    });

    const bubble = container.querySelector('[data-message-id="pending-inv-stall"]');
    expect(bubble?.querySelector('[data-testid="capability-tip-strip"]')).toBeNull();
    expect(bubble?.querySelectorAll('.animate-bounce').length).toBe(3);
  });

  it('suppresses the tip when an app-server turn is active but silent past the recovery threshold', async () => {
    const { PendingMemberBubble } = await import('@/components/PendingMemberBubble');

    await act(async () => {
      root.render(
        React.createElement(PendingMemberBubble, {
          catId: 'opus',
          invocationId: 'inv-silent-active',
          catStatus: 'streaming',
          appServerLifecycle: {
            stage: 'active',
            lastActivityAt: Date.now() - 120_001,
            recoveryAttempt: 0,
            turnStartSent: true,
            turnAccepted: true,
            itemObserved: false,
          },
          showCapabilityTip: true,
        }),
      );
      await Promise.resolve();
    });

    const bubble = container.querySelector('[data-message-id="pending-inv-silent-active"]');
    expect(bubble?.querySelector('[data-testid="capability-tip-strip"]')).toBeNull();
    expect(bubble?.querySelectorAll('.animate-bounce').length).toBe(3);
  });

  it('uses dots when another pending invocation already owns the single tip slot', async () => {
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
    expect(bubble?.querySelector('[data-testid="capability-tip-strip"]')).toBeNull();
    expect(bubble?.querySelectorAll('.animate-bounce').length).toBe(3);
  });
});
