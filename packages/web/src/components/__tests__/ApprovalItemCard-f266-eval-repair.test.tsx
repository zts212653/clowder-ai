import type { ApprovalHubItem } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const approveProposal = vi.fn();
const rejectProposal = vi.fn();

vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({ threads: [], currentThreadId: null }),
    { getState: () => ({ currentThreadId: null }) },
  ),
}));

vi.mock('@/stores/approvalHubStore', () => ({
  useApprovalHubStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      close: vi.fn(),
      approveProposal,
      rejectProposal,
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

function item(lifecycle: Pick<ApprovalHubItem, 'resolution' | 'materialization'>): ApprovalHubItem {
  return {
    proposalId: 'eval-repair-v1-proposal',
    sourceFeatureId: 'F266',
    requesterCatId: 'codex-sol',
    ownerUserId: 'operator',
    summary: 'Eval repair · approval renderer vocabulary',
    detail: {
      expectedChange: 'Project one canonical lifecycle vocabulary',
      ownerAuthorizationRef: 'authorization:F266:v1',
      targetVersionRef: 'target:F246@exact-head',
    },
    navigation: {
      state: 'anchored',
      originRef: { kind: 'message', threadId: 'thread-f313', messageId: 'message-f313' },
      approvalCardRef: { threadId: 'thread-f313', messageId: 'card-f313' },
    },
    inlineApprovable: lifecycle.resolution === 'open',
    decisionMode: 'approve-reject',
    createdAt: Date.now() - 60_000,
    ...lifecycle,
  };
}

describe('F313 F266 Approval Hub card', () => {
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
    approveProposal.mockReset();
    rejectProposal.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('offers the canonical decision only for an open proposal', async () => {
    await act(async () =>
      root.render(<ApprovalItemCard item={item({ resolution: 'open', materialization: { state: 'not_started' } })} />),
    );

    expect(container.textContent).toContain('Eval repair');
    const approve = container.querySelector<HTMLButtonElement>('[data-testid="approve-btn"]');
    expect(approve).not.toBeNull();
    await act(async () => approve?.click());
    expect(approveProposal).toHaveBeenCalledWith('eval-repair-v1-proposal');
  });

  it('renders accepted outcome_unknown without legacy recovery vocabulary or decision controls', async () => {
    await act(async () =>
      root.render(
        <ApprovalItemCard item={item({ resolution: 'accepted', materialization: { state: 'outcome_unknown' } })} />,
      ),
    );

    expect(container.textContent).toContain('已批准 · 结果待确认');
    expect(container.textContent).not.toMatch(/resume-only|继续完成|待恢复|approving|applying/iu);
    expect(container.querySelector('[data-testid="approve-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="reject-btn"]')).toBeNull();
  });
});
