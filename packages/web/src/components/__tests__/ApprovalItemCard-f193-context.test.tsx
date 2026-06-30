/**
 * F246 Bug 1: F193 dispatch card context + jump button regression tests.
 *
 * operator bug report: "如果是审批 f193这个我根本不知道是哪个thread的什么猫往哪thread的什么猫发！！
 * 也没跳转按钮！看不懂！只能乱审批"
 *
 * Guards:
 * - F193 card must show sourceThreadId context
 * - F193 card must show targetThreadId context (from detail.targetThreadId)
 * - F193 card must have a jump button alongside approve/reject (not instead of)
 * - F128/F225 cards remain unaffected (no regression)
 */

import type { ApprovalItem } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const SOURCE_THREAD_ID = 'thread-source-alpha';
const TARGET_THREAD_ID = 'thread-target-beta';
const SOURCE_THREAD_TITLE = 'Alpha 任务线';
const TARGET_THREAD_TITLE = 'Beta 执行线';

const F193_ITEM: ApprovalItem = {
  proposalId: 'ctx-f193-1',
  sourceFeatureId: 'F193',
  sourceThreadId: SOURCE_THREAD_ID,
  sourceMessageId: 'msg-ctx-1',
  requesterCatId: 'opus',
  ownerUserId: 'user-landy',
  status: 'pending',
  summary: 'Work assignment: 请帮忙调研 F246 下一步方向',
  detail: {
    targetThreadId: TARGET_THREAD_ID,
    targetCats: ['sonnet', 'gpt52'],
    content: '请帮忙调研 F246 下一步方向',
    effectClass: 'assign_work',
  },
  inlineApprovable: true,
  createdAt: Date.now() - 120_000,
};

const F193_ITEM_NO_THREAD_IN_STORE: ApprovalItem = {
  ...F193_ITEM,
  proposalId: 'ctx-f193-2',
  sourceThreadId: 'thread-unknown-src',
  detail: {
    ...F193_ITEM.detail,
    targetThreadId: 'thread-unknown-tgt',
  },
};

// chatStore mock — returns titles for known thread IDs
vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        threads: [
          { id: SOURCE_THREAD_ID, title: SOURCE_THREAD_TITLE },
          { id: TARGET_THREAD_ID, title: TARGET_THREAD_TITLE },
        ],
        currentThreadId: null,
      }),
    {
      getState: () => ({ currentThreadId: null }),
    },
  ),
}));

vi.mock('@/stores/approvalHubStore', () => ({
  useApprovalHubStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      close: vi.fn(),
      approveProposal: vi.fn(),
      rejectProposal: vi.fn(),
      deciding: {},
      selectedIds: new Set<string>(),
      toggleSelection: vi.fn(),
    }),
}));

vi.mock('@/utils/scrollToMessage', () => ({ scrollToMessage: vi.fn() }));
vi.mock('@/utils/teleport', () => ({ planTeleport: () => ({}), kickTeleportResolve: vi.fn() }));
vi.mock('../ThreadSidebar/thread-navigation', () => ({ pushThreadRouteWithHistory: vi.fn() }));

import { ApprovalItemCard } from '../ApprovalItemCard';

describe('F246 Bug 1: F193 card context + jump button', () => {
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

  it('F193 card shows source thread title', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalItemCard, { item: F193_ITEM }));
    });

    const card = container.querySelector('[data-testid="approval-item-ctx-f193-1"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain(SOURCE_THREAD_TITLE);
  });

  it('F193 card shows target thread title', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalItemCard, { item: F193_ITEM }));
    });

    const card = container.querySelector('[data-testid="approval-item-ctx-f193-1"]');
    expect(card!.textContent).toContain(TARGET_THREAD_TITLE);
  });

  it('F193 card shows source thread ID as fallback when not in chatStore', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalItemCard, { item: F193_ITEM_NO_THREAD_IN_STORE }));
    });

    const card = container.querySelector('[data-testid="approval-item-ctx-f193-2"]');
    expect(card).not.toBeNull();
    // Should show the raw ID or a truncated version as fallback
    expect(card!.textContent).toMatch(/thread-unknown-src|unknown-src/);
  });

  it('F193 card has a jump-btn alongside approve/reject buttons', async () => {
    await act(async () => {
      root.render(React.createElement(ApprovalItemCard, { item: F193_ITEM }));
    });

    const card = container.querySelector('[data-testid="approval-item-ctx-f193-1"]');
    const approveBtn = card!.querySelector('[data-testid="approve-btn"]');
    const rejectBtn = card!.querySelector('[data-testid="reject-btn"]');
    const jumpBtn = card!.querySelector('[data-testid="jump-btn"]');

    // ALL THREE must be present
    expect(approveBtn).not.toBeNull();
    expect(rejectBtn).not.toBeNull();
    expect(jumpBtn).not.toBeNull();
  });

  it('F193 card jump-btn exists even for non-inlineApprovable item (edge case)', async () => {
    const nonInlineF193: ApprovalItem = { ...F193_ITEM, proposalId: 'ctx-f193-3', inlineApprovable: false };
    await act(async () => {
      root.render(React.createElement(ApprovalItemCard, { item: nonInlineF193 }));
    });

    const card = container.querySelector('[data-testid="approval-item-ctx-f193-3"]');
    const jumpBtn = card!.querySelector('[data-testid="jump-btn"]');
    expect(jumpBtn).not.toBeNull();
  });
});
