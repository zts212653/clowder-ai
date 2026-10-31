import type { SettledApprovalHubItem } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anchoredApprovalNavigation } from '@/test-support/approval-navigation';

vi.mock('@/stores/chatStore', () => ({
  useChatStore: { getState: () => ({ currentThreadId: 'thread-current' }) },
}));

vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({
  pushThreadRouteWithHistory: vi.fn(),
}));

import { SettledHistoryCard } from '../SettledHistoryCard';

const TASTE_ITEM: SettledApprovalHubItem = {
  proposalId: 'taste-settled-1',
  sourceFeatureId: 'F221',
  navigation: anchoredApprovalNavigation('thread-taste'),
  requesterCatId: 'codex-sol',
  ownerUserId: 'user-1',
  resolution: 'accepted',
  materialization: { state: 'outcome_unknown' },
  summary: 'Taste [visual-quality]: 平铺会越来越难管理',
  detail: {
    scene: '讨论记忆系统如何唤醒 proposal/cue',
    quote: '这个是必须要坚持的不然 query 每回合注入会变成一个又臭又长的垃圾',
    dimension: 'architecture-aesthetics',
    tags: ['prompt-budget', 'standing-reflex'],
    technicalNotes:
      '只常驻短小的窄法级路由指针，具体内容按场景 predicate 动态注入，禁止把所有记忆规则硬塞进每轮 query。',
  },
  decidedAt: Date.now() - 60_000,
  decidedBy: 'operator',
  createdAt: Date.now() - 120_000,
};

describe('F246/F221 settled history label', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders the human label 品味 instead of the raw F221 id', async () => {
    await act(async () => {
      root.render(React.createElement(SettledHistoryCard, { item: TASTE_ITEM }));
    });

    const badge = container.querySelector('[data-testid="settled-card-feature-badge"]');
    expect(badge?.textContent).toBe('品味');
    expect(container.textContent).not.toContain('F221');
  });

  it('uses the shared F305 approval card shell with the title before supporting metadata', async () => {
    await act(async () => {
      root.render(React.createElement(SettledHistoryCard, { item: TASTE_ITEM }));
    });

    const card = container.querySelector<HTMLElement>(`[data-testid="settled-card-${TASTE_ITEM.proposalId}"]`);
    const summary = container.querySelector<HTMLElement>('[data-testid="settled-card-summary"]');
    const actors = container.querySelector<HTMLElement>('[data-testid="settled-card-actors"]');

    expect(card?.tagName).toBe('ARTICLE');
    expect(card?.dataset.approvalCardShell).toBe('true');
    expect(card?.className).toContain('rounded-xl');
    expect(summary).not.toBeNull();
    expect(actors).not.toBeNull();
    expect((summary?.compareDocumentPosition(actors as Node) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it('keeps history compact while preserving the complete decision context behind an explicit disclosure', async () => {
    await act(async () => {
      root.render(React.createElement(SettledHistoryCard, { item: TASTE_ITEM }));
    });

    const summary = container.querySelector('[data-testid="settled-card-summary"]')?.textContent;
    expect(summary).not.toContain('Taste');
    expect(summary).toContain('[visual-quality]');
    expect(container.querySelector('[data-testid="settled-card-status"]')?.textContent).toBe('已批准 · 结果待确认');
    expect(container.textContent).not.toContain('approved');
    const actors = container.querySelector('[data-testid="settled-card-actors"]')?.textContent;
    expect(actors).toContain('发起人：codex-sol');
    expect(actors).toContain('决定人：operator');
    expect(container.querySelector('[data-testid="settled-card-time"]')?.textContent).toContain('处理于');

    const disclosure = container.querySelector<HTMLDetailsElement>('[data-testid="settled-card-technical-details"]');
    expect(disclosure).not.toBeNull();
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.textContent).toContain('查看技术详情');
    expect(disclosure?.textContent).toContain('architecture-aesthetics');
    expect(disclosure?.textContent).toContain(
      '只常驻短小的窄法级路由指针，具体内容按场景 predicate 动态注入，禁止把所有记忆规则硬塞进每轮 query。',
    );

    await act(async () => {
      disclosure?.querySelector('summary')?.click();
      disclosure?.dispatchEvent(new Event('toggle'));
    });
    expect(disclosure?.open).toBe(true);
    expect(disclosure?.textContent).toContain('收起技术详情');
  });
});
