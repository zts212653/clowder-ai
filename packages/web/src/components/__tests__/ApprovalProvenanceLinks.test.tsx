import type { ApprovalNavigation } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigationMocks = vi.hoisted(() => ({
  kickTeleportResolve: vi.fn(),
  planTeleport: vi.fn(({ messageId }: { messageId: string }) => ({ scrollNow: messageId })),
  pushThreadRouteWithHistory: vi.fn(),
  scrollToMessage: vi.fn(),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: { getState: () => ({ currentThreadId: 'thread-current' }) },
}));
vi.mock('@/utils/scrollToMessage', () => ({ scrollToMessage: navigationMocks.scrollToMessage }));
vi.mock('@/utils/teleport', () => ({
  kickTeleportResolve: navigationMocks.kickTeleportResolve,
  planTeleport: navigationMocks.planTeleport,
}));
vi.mock('../ThreadSidebar/thread-navigation', () => ({
  pushThreadRouteWithHistory: navigationMocks.pushThreadRouteWithHistory,
}));

import { ApprovalProvenanceLinks } from '../ApprovalProvenanceLinks';

describe('F246 approval provenance links', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps approval-card and triggering-message anchors distinct', async () => {
    const onBeforeNavigate = vi.fn();
    const navigation: ApprovalNavigation = {
      state: 'anchored',
      originRef: { kind: 'message', threadId: 'thread-origin', messageId: 'message-origin' },
      approvalCardRef: { threadId: 'thread-card', messageId: 'message-card' },
    };
    await act(async () =>
      root.render(<ApprovalProvenanceLinks navigation={navigation} onBeforeNavigate={onBeforeNavigate} />),
    );

    const cardLink = container.querySelector('[data-testid="approval-card-link"]') as HTMLButtonElement;
    const originLink = container.querySelector('[data-testid="approval-origin-link"]') as HTMLButtonElement;
    expect(cardLink.textContent).toContain('查看审批卡');
    expect(originLink.textContent).toContain('查看触发原文');

    await act(async () => cardLink.click());
    expect(navigationMocks.planTeleport).toHaveBeenLastCalledWith({
      threadId: 'thread-card',
      messageId: 'message-card',
      currentThreadId: 'thread-current',
    });
    await act(async () => originLink.click());
    expect(navigationMocks.planTeleport).toHaveBeenLastCalledWith({
      threadId: 'thread-origin',
      messageId: 'message-origin',
      currentThreadId: 'thread-current',
    });
    expect(onBeforeNavigate).toHaveBeenCalledTimes(2);
  });

  it('renders event provenance honestly without inventing an origin-message jump', async () => {
    const navigation: ApprovalNavigation = {
      state: 'anchored',
      originRef: { kind: 'event', anchor: 'cron:daily', summary: '每日治理扫描' },
      approvalCardRef: { threadId: 'thread-card', messageId: 'message-card' },
    };
    await act(async () => root.render(<ApprovalProvenanceLinks navigation={navigation} />));

    expect(container.querySelector('[data-testid="approval-card-link"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="approval-origin-link"]')).toBeNull();
    expect(container.querySelector('[data-testid="approval-event-origin"]')?.textContent).toContain('每日治理扫描');
  });

  it('marks legacy records as non-exact and only offers an honest thread fallback', async () => {
    const navigation: ApprovalNavigation = {
      state: 'legacy_unanchored',
      legacyThreadId: 'thread-legacy',
      legacyMessageId: 'message-untrusted',
    };
    await act(async () => root.render(<ApprovalProvenanceLinks navigation={navigation} />));

    expect(container.querySelector('[data-testid="approval-legacy-warning"]')?.textContent).toContain('无法精确跳转');
    expect(container.querySelector('[data-testid="approval-card-link"]')).toBeNull();
    expect(container.querySelector('[data-testid="approval-origin-link"]')).toBeNull();

    const fallback = container.querySelector('[data-testid="approval-legacy-thread-link"]') as HTMLButtonElement;
    await act(async () => fallback.click());
    expect(navigationMocks.pushThreadRouteWithHistory).toHaveBeenCalledWith('thread-legacy', window);
    expect(navigationMocks.planTeleport).not.toHaveBeenCalled();
  });
});
