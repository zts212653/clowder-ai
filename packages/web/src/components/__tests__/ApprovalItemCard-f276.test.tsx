import type { ApprovalItem } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { anchoredApprovalNavigation } from '@/test-support/approval-navigation';

const storeMocks = vi.hoisted(() => ({
  approvePersonMemory: vi.fn(),
  notNowPersonMemory: vi.fn(),
  withdrawPersonMemory: vi.fn(),
  rejectProposal: vi.fn(),
}));
const navigationMocks = vi.hoisted(() => ({
  planTeleport: vi.fn(() => ({ navigateTo: 'thread_people' })),
  pushThreadRouteWithHistory: vi.fn(),
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
      approvePersonMemory: storeMocks.approvePersonMemory,
      notNowPersonMemory: storeMocks.notNowPersonMemory,
      withdrawPersonMemory: storeMocks.withdrawPersonMemory,
      deciding: {},
    }),
}));
vi.mock('@/utils/scrollToMessage', () => ({ scrollToMessage: vi.fn() }));
vi.mock('@/utils/teleport', () => ({
  planTeleport: navigationMocks.planTeleport,
  kickTeleportResolve: vi.fn(),
}));
vi.mock('../ThreadSidebar/thread-navigation', () => ({
  pushThreadRouteWithHistory: navigationMocks.pushThreadRouteWithHistory,
}));

import { ApprovalItemCard } from '../ApprovalItemCard';

const ITEM: ApprovalItem = {
  proposalId: 'person_candidate_1',
  sourceFeatureId: 'F276',
  navigation: anchoredApprovalNavigation('thread_people'),
  requesterCatId: 'codex-sol',
  ownerUserId: 'owner-1',
  status: 'pending',
  summary: '记住人物：黄挺',
  detail: {
    displayName: '黄挺',
    drafts: [
      {
        draftId: 'person_draft_fact',
        claimKind: 'reported_fact',
        normalizedDraft: '黄挺属于终端用户计算开发部',
        sourceRole: 'owner_explicit',
        evidenceExcerpt: '黄挺是终端用户计算开发部 21 级',
      },
      {
        draftId: 'person_draft_event',
        claimKind: 'interaction_event',
        normalizedDraft: '与黄挺线下见面，日期存在冲突',
        sourceRole: 'owner_explicit',
        evidenceExcerpt: '7 月 23 日周三，见了大约两个小时',
        event: {
          eventKind: 'meeting',
          headline: '与黄挺线下见面并讨论终端用户计算',
          occurredAt: {
            kind: 'conflict',
            raw: '7 月 23 日（周三）',
            alternatives: [
              { label: 'explicit_date', value: '2026-07-23' },
              { label: 'weekday_resolution', value: '2026-07-22' },
            ],
          },
          duration: {
            kind: 'approximate',
            raw: '大约两个小时',
            qualifier: 'about',
          },
          importanceOrTopic: '交流终端用户计算方向，也让双方关系更具体',
          uncertaintyNotes: ['日期与星期存在冲突'],
          sourceEvidence: [
            {
              sourceRef: { kind: 'message', threadId: 'thread_people', messageId: 'msg_event_1' },
              evidenceExcerpt: '线下见了大约两个小时',
              supports: ['eventKind', 'headline', 'occurredAt', 'duration'],
            },
            {
              sourceRef: { kind: 'message', threadId: 'thread_people', messageId: 'msg_event_2' },
              evidenceExcerpt: '聊了终端用户计算，这次见面对我挺重要，但日期和星期冲突',
              supports: ['importanceOrTopic', 'uncertaintyNotes'],
            },
          ],
        },
      },
    ],
    remainingDraftIds: ['person_draft_fact', 'person_draft_event'],
    replacesProposalId: 'person_candidate_previous',
  },
  inlineApprovable: true,
  decisionMode: 'claim-select',
  createdAt: Date.now(),
};

describe('ApprovalItemCard F276', () => {
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
    vi.clearAllMocks();
    storeMocks.rejectProposal.mockResolvedValue(true);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders claim-level source and excerpt, then submits only checked IDs', async () => {
    await act(async () => root.render(<ApprovalItemCard item={ITEM} />));
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(container.textContent).toContain('You 明确陈述');
    expect(container.textContent).toContain('事实 · You 明确陈述');
    expect(container.textContent).toContain('7 月 23 日（周三）');
    expect(container.textContent).toContain('这是纠正版；旧卡会被撤回');

    const second = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1];
    await act(async () => second?.click());
    const approve = container.querySelector<HTMLButtonElement>('[data-testid="person-memory-approve-selected"]');
    await act(async () => approve?.click());
    expect(storeMocks.approvePersonMemory).toHaveBeenCalledWith(ITEM.proposalId, ['person_draft_fact']);
  });

  it('offers not-now, cancel, and reject without rendering the generic approve button', async () => {
    await act(async () => root.render(<ApprovalItemCard item={ITEM} />));
    expect(container.querySelector('[data-testid="approve-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="person-memory-not-now"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="person-memory-withdraw"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="person-memory-reject"]')).not.toBeNull();
  });

  it('opens a feedback dialog for reject without offering the not-now reason', async () => {
    await act(async () => root.render(<ApprovalItemCard item={ITEM} />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="person-memory-reject"]')?.click());

    expect(storeMocks.rejectProposal).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector('input[value="not_now"]')).toBeNull();

    await act(async () => container.querySelector<HTMLInputElement>('input[value="bad_evidence"]')?.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="feedback-submit"]')?.click());
    expect(storeMocks.rejectProposal).toHaveBeenCalledWith(ITEM.proposalId, { reasonCode: 'bad_evidence' });
  });

  it('shows an informed event narrative and drills each factual source before approval', async () => {
    await act(async () => root.render(<ApprovalItemCard item={ITEM} />));

    expect(container.textContent).toContain('人物：黄挺');
    expect(container.textContent).toContain('发生了什么：与黄挺线下见面并讨论终端用户计算');
    expect(container.textContent).toContain('时间：7 月 23 日（周三）');
    expect(container.textContent).toContain('时长：大约两个小时');
    expect(container.textContent).toContain('主题/重要性：交流终端用户计算方向，也让双方关系更具体');
    expect(container.textContent).toContain('仍不确定：日期与星期存在冲突');
    expect(container.textContent).toContain('线下见了大约两个小时');
    expect(container.textContent).toContain('聊了终端用户计算');

    const sourceButtons = container.querySelectorAll<HTMLButtonElement>('[data-testid^="person-memory-event-source-"]');
    expect(sourceButtons).toHaveLength(2);
    await act(async () => sourceButtons[1]?.click());
    expect(navigationMocks.planTeleport).toHaveBeenCalledWith({
      threadId: 'thread_people',
      messageId: 'msg_event_2',
      currentThreadId: null,
    });
    expect(navigationMocks.pushThreadRouteWithHistory).toHaveBeenCalledWith('thread_people', expect.anything());
  });

  it('renders and drills a typed-only interaction from source-to-field informed evidence', async () => {
    const typedItem = structuredClone(ITEM);
    const eventDraft = (typedItem.detail.drafts as Array<Record<string, unknown>>)[1];
    const event = eventDraft.event as Record<string, unknown>;
    event.sourceEvidence = [];
    eventDraft.informedEvidence = [
      {
        sourceId: 'typed-meeting',
        sourceKind: 'message_text',
        assertionRoles: ['reported_fact', 'user_assessment'],
        targetFields: ['eventKind', 'headline', 'importanceOrTopic'],
        boundedExcerpt: '我和黄挺开会，这件事很重要',
        drillSourceRef: { kind: 'message', threadId: 'thread_people', messageId: 'msg_typed_event' },
      },
    ];

    await act(async () => root.render(<ApprovalItemCard item={typedItem} />));

    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(container.textContent).toContain('事件类型、发生了什么、主题/重要性');
    expect(container.textContent).toContain('message_text');
    expect(container.textContent).toContain('reported_fact');
    expect(container.textContent).toContain('user_assessment');
    expect(container.textContent).toContain('我和黄挺开会，这件事很重要');

    const source = container.querySelector<HTMLButtonElement>('[data-testid="person-memory-informed-source-0"]');
    expect(source).not.toBeNull();
    await act(async () => source?.click());
    expect(navigationMocks.planTeleport).toHaveBeenCalledWith({
      threadId: 'thread_people',
      messageId: 'msg_typed_event',
      currentThreadId: null,
    });
  });
});
