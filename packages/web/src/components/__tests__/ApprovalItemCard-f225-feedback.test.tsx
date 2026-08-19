import type { ApprovalItem } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { anchoredApprovalNavigation } from '@/test-support/approval-navigation';

const storeMocks = vi.hoisted(() => ({
  rejectProposal: vi.fn(),
  error: null as string | null,
  deciding: {} as Record<string, string>,
}));

vi.mock('@/stores/chatStore', () => {
  const useChatStore = (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ threads: [], currentThreadId: null });
  useChatStore.getState = () => ({ threads: [], currentThreadId: null });
  return { useChatStore };
});
vi.mock('@/stores/approvalHubStore', () => ({
  useApprovalHubStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      close: vi.fn(),
      approveProposal: vi.fn(),
      rejectProposal: storeMocks.rejectProposal,
      resolveEntityConflict: vi.fn(),
      deciding: storeMocks.deciding,
      error: storeMocks.error,
    }),
}));
vi.mock('@/utils/scrollToMessage', () => ({ scrollToMessage: vi.fn() }));
vi.mock('@/utils/teleport', () => ({ planTeleport: () => ({}), kickTeleportResolve: vi.fn() }));
vi.mock('../ThreadSidebar/thread-navigation', () => ({ pushThreadRouteWithHistory: vi.fn() }));

import { ApprovalItemCard } from '../ApprovalItemCard';

const ITEM: ApprovalItem = {
  proposalId: 'handoff_feedback_1',
  sourceFeatureId: 'F225',
  navigation: anchoredApprovalNavigation('thread-handoff'),
  requesterCatId: 'codex-sol',
  ownerUserId: 'owner-1',
  status: 'pending',
  summary: '接续 F281 Phase B',
  detail: { done: 'Phase A landed', nextSteps: 'capture feedback' },
  inlineApprovable: false,
  createdAt: Date.now(),
};

describe('ApprovalItemCard F225 feedback capture', () => {
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
    storeMocks.error = null;
    storeMocks.deciding = {};
    storeMocks.rejectProposal.mockReset();
    storeMocks.rejectProposal.mockResolvedValue(true);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('opens the producer catalog dialog and submits a structured reason', async () => {
    await act(async () => root.render(<ApprovalItemCard item={ITEM} />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="reject-btn"]')?.click());

    expect(storeMocks.rejectProposal).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(ITEM.summary);
    expect(container.querySelector('input[value="not_now"]')).not.toBeNull();

    await act(async () => container.querySelector<HTMLInputElement>('input[value="wrong_lane"]')?.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="feedback-submit"]')?.click());

    expect(storeMocks.rejectProposal).toHaveBeenCalledTimes(1);
    expect(storeMocks.rejectProposal).toHaveBeenCalledWith(ITEM.proposalId, { reasonCode: 'wrong_lane' });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps the dialog open when the route rejects the decision', async () => {
    storeMocks.error = 'decision_conflict';
    storeMocks.rejectProposal.mockResolvedValue(false);
    await act(async () => root.render(<ApprovalItemCard item={ITEM} />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="reject-btn"]')?.click());
    await act(async () => container.querySelector<HTMLInputElement>('input[value="wrong"]')?.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="feedback-submit"]')?.click());

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('拒绝失败，请检查提案状态后重试。');
  });
});
