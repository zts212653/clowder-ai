import type { ApprovalItem, ApprovalProducerId } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        threads: [],
        currentThreadId: null,
      }),
    {
      getState: () => ({ currentThreadId: null }),
    },
  ),
}));

vi.mock('@/stores/approvalHubStore', () => ({
  useApprovalHubStore: (selector: (state: Record<string, unknown>) => unknown) =>
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

function approvalItem(sourceFeatureId: ApprovalProducerId, detail: Record<string, unknown>): ApprovalItem {
  return {
    proposalId: `f269-${sourceFeatureId.toLowerCase()}`,
    sourceFeatureId,
    requesterCatId: 'codex-sol',
    ownerUserId: 'user-landy',
    status: 'pending',
    summary: `${sourceFeatureId} critical context`,
    detail,
    navigation: {
      state: 'anchored',
      originRef: { kind: 'message', threadId: 'thread-f269-source', messageId: 'message-f269-source' },
      approvalCardRef: { threadId: 'thread-f269-source', messageId: `card-${sourceFeatureId.toLowerCase()}` },
    },
    inlineApprovable: false,
    createdAt: Date.now() - 60_000,
  };
}

const CASES = [
  {
    name: 'F128 approval reason',
    item: approvalItem('F128', { reason: '必须确认权限边界、脱敏策略与完整回滚路径。' }),
    expected: ['必须确认权限边界、脱敏策略与完整回滚路径。'],
  },
  {
    name: 'F225 handoff record',
    item: approvalItem('F225', {
      done: '已经完成全部数据迁移与逐项校验。',
      nextSteps: '下一位接棒猫先验证 main，再恢复发布。',
    }),
    expected: ['已经完成全部数据迁移与逐项校验。', '下一位接棒猫先验证 main，再恢复发布。'],
  },
  {
    name: 'F221 taste evidence',
    item: approvalItem('F221', {
      scene: '当审批卡需要支持不可逆决定时，依据必须完整可达。',
      quote: '省略号不能成为信息终点。',
      tags: ['overflow'],
    }),
    expected: ['当审批卡需要支持不可逆决定时，依据必须完整可达。', '省略号不能成为信息终点。'],
  },
  {
    name: 'F193 dispatch content',
    item: approvalItem('F193', {
      targetThreadId: 'thread-f269-target',
      targetCats: ['glm52'],
      content: '请在目标线程核验完整证据后再接球，不要只看摘要。',
    }),
    expected: ['请在目标线程核验完整证据后再接球，不要只看摘要。'],
  },
  {
    name: 'F260 registration rationale',
    item: approvalItem('F260', {
      entityId: 'concept:recoverable-overflow',
      entityType: 'concept',
      canonicalName: 'Recoverable Overflow',
      rationale: '这是会影响后续登记决策的完整理由，不能只显示前两行。',
    }),
    expected: ['这是会影响后续登记决策的完整理由，不能只显示前两行。'],
  },
] as const;

describe('F269 ApprovalItemCard critical text recovery', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
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

  it.each(CASES)('$name uses a visible disclosure that reaches every detail', async ({ item, expected }) => {
    await act(async () => {
      root.render(React.createElement(ApprovalItemCard, { item }));
    });

    const card = container.querySelector(`[data-testid="approval-item-${item.proposalId}"]`);
    expect(card).not.toBeNull();
    expect(card?.querySelector('[class*="line-clamp-"]')).toBeNull();

    const disclosure = card?.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    expect(disclosure).not.toBeNull();
    await act(async () => disclosure?.click());

    expect(card?.querySelector('button[aria-expanded="true"]')).not.toBeNull();
    for (const detail of expected) expect(card?.textContent).toContain(detail);
  });
});
