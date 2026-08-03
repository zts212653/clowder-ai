/**
 * Reject/dismiss button must render for ALL approval items, regardless of
 * inlineApprovable. The approve button correctly requires inlineApprovable
 * (some features need context the Hub drawer can't provide), but reject
 * needs no context — you're just dismissing the proposal.
 *
 * operator bug report: "过期的 或者不想审批的 我也没拒绝 or 清理的地方啊？他就和
 * 狗皮膏药这样粘住我了"
 *
 * Guards:
 * 1. F128 (Thread) card with inlineApprovable=false must have dismiss button
 * 2. F225 (Handoff) card with inlineApprovable=false must have dismiss button
 * 3. F231 (Profile) card with inlineApprovable=false must have dismiss button
 * 4. Stale F128 card shows "清除" label instead of "拒绝"
 * 5. Non-stale F128 card shows "拒绝" label
 * 6. inlineApprovable=true items still have both approve AND reject (no regression)
 */

import type { ApprovalItem } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { anchoredApprovalNavigation } from '@/test-support/approval-navigation';

vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector({ threads: [], currentThreadId: null }),
    { getState: () => ({ currentThreadId: null }) },
  ),
}));

vi.mock('@/stores/approvalHubStore', () => ({
  useApprovalHubStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      close: vi.fn(),
      approveProposal: vi.fn(),
      rejectProposal: vi.fn(),
      resolveEntityConflict: vi.fn(),
      deciding: {},
      selectedIds: new Set<string>(),
      toggleSelection: vi.fn(),
    }),
}));

vi.mock('@/utils/scrollToMessage', () => ({ scrollToMessage: vi.fn() }));
vi.mock('@/utils/teleport', () => ({ planTeleport: () => ({}), kickTeleportResolve: vi.fn() }));
vi.mock('../ThreadSidebar/thread-navigation', () => ({ pushThreadRouteWithHistory: vi.fn() }));

import { ApprovalItemCard } from '../ApprovalItemCard';

const BASE_NAV = anchoredApprovalNavigation('thread-test-src');

function makeItem(
  overrides: Partial<ApprovalItem> & { proposalId: string; sourceFeatureId: ApprovalItem['sourceFeatureId'] },
): ApprovalItem {
  return {
    requesterCatId: 'opus',
    ownerUserId: 'user-landy',
    status: 'pending',
    summary: 'Test proposal',
    detail: {},
    navigation: BASE_NAV,
    inlineApprovable: false,
    createdAt: Date.now() - 120_000,
    ...overrides,
  };
}

describe('Reject/dismiss button renders for all items (狗皮膏药 fix)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as Record<string, unknown>).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('F128 (Thread) card with inlineApprovable=false has dismiss button', async () => {
    const item = makeItem({ proposalId: 'rej-f128-1', sourceFeatureId: 'F128', inlineApprovable: false });
    await act(async () => {
      root.render(React.createElement(ApprovalItemCard, { item }));
    });

    const card = container.querySelector('[data-testid="approval-item-rej-f128-1"]');
    expect(card).not.toBeNull();
    const dismissBtn = card!.querySelector('[data-testid="reject-btn"], [data-testid="dismiss-btn"]');
    expect(dismissBtn).not.toBeNull();
  });

  it('F225 (Handoff) card with inlineApprovable=false has dismiss button', async () => {
    const item = makeItem({ proposalId: 'rej-f225-1', sourceFeatureId: 'F225', inlineApprovable: false });
    await act(async () => {
      root.render(React.createElement(ApprovalItemCard, { item }));
    });

    const card = container.querySelector('[data-testid="approval-item-rej-f225-1"]');
    const dismissBtn = card!.querySelector('[data-testid="reject-btn"], [data-testid="dismiss-btn"]');
    expect(dismissBtn).not.toBeNull();
  });

  it('F231 (Profile) card with inlineApprovable=false has dismiss button', async () => {
    const item = makeItem({ proposalId: 'rej-f231-1', sourceFeatureId: 'F231', inlineApprovable: false });
    await act(async () => {
      root.render(React.createElement(ApprovalItemCard, { item }));
    });

    const card = container.querySelector('[data-testid="approval-item-rej-f231-1"]');
    const dismissBtn = card!.querySelector('[data-testid="reject-btn"], [data-testid="dismiss-btn"]');
    expect(dismissBtn).not.toBeNull();
  });

  it('stale F128 card shows "清除" label', async () => {
    const item = makeItem({
      proposalId: 'rej-f128-stale',
      sourceFeatureId: 'F128',
      inlineApprovable: false,
      expiresAt: Date.now() - 86_400_000, // expired 1 day ago
    });
    await act(async () => {
      root.render(React.createElement(ApprovalItemCard, { item }));
    });

    const card = container.querySelector('[data-testid="approval-item-rej-f128-stale"]');
    const dismissBtn = card!.querySelector('[data-testid="reject-btn"], [data-testid="dismiss-btn"]');
    expect(dismissBtn).not.toBeNull();
    expect(dismissBtn!.textContent).toBe('清除');
  });

  it('stale feedback-capable cards clear directly without opening a reason dialog', async () => {
    const item = makeItem({
      proposalId: 'rej-f225-stale',
      sourceFeatureId: 'F225',
      inlineApprovable: false,
      expiresAt: Date.now() - 86_400_000,
    });
    await act(async () => root.render(React.createElement(ApprovalItemCard, { item })));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="reject-btn"]')?.click());

    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('non-stale F128 card shows "拒绝" label', async () => {
    const item = makeItem({ proposalId: 'rej-f128-fresh', sourceFeatureId: 'F128', inlineApprovable: false });
    await act(async () => {
      root.render(React.createElement(ApprovalItemCard, { item }));
    });

    const card = container.querySelector('[data-testid="approval-item-rej-f128-fresh"]');
    const dismissBtn = card!.querySelector('[data-testid="reject-btn"], [data-testid="dismiss-btn"]');
    expect(dismissBtn).not.toBeNull();
    expect(dismissBtn!.textContent).toBe('拒绝');
  });

  it('inlineApprovable=true items still have BOTH approve AND reject (no regression)', async () => {
    const item = makeItem({ proposalId: 'rej-inline-1', sourceFeatureId: 'F193', inlineApprovable: true });
    await act(async () => {
      root.render(React.createElement(ApprovalItemCard, { item }));
    });

    const card = container.querySelector('[data-testid="approval-item-rej-inline-1"]');
    expect(card!.querySelector('[data-testid="approve-btn"]')).not.toBeNull();
    expect(card!.querySelector('[data-testid="reject-btn"]')).not.toBeNull();
  });

  it('inlineApprovable=false items do NOT have approve button', async () => {
    const item = makeItem({ proposalId: 'rej-no-approve', sourceFeatureId: 'F128', inlineApprovable: false });
    await act(async () => {
      root.render(React.createElement(ApprovalItemCard, { item }));
    });

    const card = container.querySelector('[data-testid="approval-item-rej-no-approve"]');
    expect(card!.querySelector('[data-testid="approve-btn"]')).toBeNull();
  });
});
