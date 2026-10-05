/**
 * The F276 claim selector under a host: every write is guarded and lockable, the picked subset is reported as work in
 * progress, and — independent of any host — a refreshed copy of the same proposal must not throw the picked subset away.
 */
import type { ApprovalHubItem } from '@cat-cafe/shared';
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
      error: null,
    }),
}));
vi.mock('@/utils/scrollToMessage', () => ({ scrollToMessage: vi.fn() }));
vi.mock('@/utils/teleport', () => ({ planTeleport: () => ({}), kickTeleportResolve: vi.fn() }));
vi.mock('../ThreadSidebar/thread-navigation', () => ({ pushThreadRouteWithHistory: vi.fn() }));

import { type ApprovalHost, ApprovalHostContext, type ApprovalRequestEvent } from '../ApprovalHost';
import { ApprovalItemCard } from '../ApprovalItemCard';

const draft = (draftId: string, text: string) => ({
  draftId,
  claimKind: 'reported_fact',
  normalizedDraft: text,
  sourceRole: 'owner_explicit',
  evidenceExcerpt: `原话：${text}`,
});
const ITEM: ApprovalHubItem = {
  proposalId: 'p-person',
  sourceFeatureId: 'F276',
  decisionMode: 'claim-select',
  navigation: anchoredApprovalNavigation('thread_people'),
  requesterCatId: 'codex-sol',
  ownerUserId: 'owner-1',
  resolution: 'open',
  materialization: { state: 'not_started' },
  summary: '记住人物：黄挺',
  detail: {
    displayName: '黄挺',
    drafts: [draft('d1', '黄挺属于终端用户计算开发部'), draft('d2', '黄挺是 21 级'), draft('d3', '黄挺在北京')],
    remainingDraftIds: ['d1', 'd2', 'd3'],
  },
  inlineApprovable: true,
  createdAt: Date.now() - 60_000,
};

function makeHost(overrides: Partial<ApprovalHost> = {}) {
  const calls = {
    authorize: [] as string[],
    editing: [] as [string, boolean][],
    requests: [] as ApprovalRequestEvent[],
  };
  const host: ApprovalHost = {
    writesLocked: false,
    authorizeWrite: (kind) => {
      calls.authorize.push(kind);
      return true;
    },
    reportEditing: (source, editing) => calls.editing.push([source, editing]),
    reportRequest: (event) => calls.requests.push(event),
    ...overrides,
  };
  return { host, calls };
}

describe('F276 claim selector under a host', () => {
  let container: HTMLDivElement;
  let root: Root;
  const byTestId = <T extends HTMLElement>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`);
  const checkbox = (text: string) =>
    [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((box) =>
      box.getAttribute('aria-label')?.includes(text),
    );
  const render = async (item: ApprovalHubItem, host?: ApprovalHost) =>
    act(async () =>
      root.render(
        host ? (
          <ApprovalHostContext.Provider value={host}>
            <ApprovalItemCard item={item} />
          </ApprovalHostContext.Provider>
        ) : (
          <ApprovalItemCard item={item} />
        ),
      ),
    );
  const click = (id: string) => act(async () => byTestId<HTMLButtonElement>(id)?.click());
  const toggle = (text: string) => act(async () => checkbox(text)?.click());

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
    for (const mock of Object.values(storeMocks)) {
      mock.mockReset();
      mock.mockResolvedValue(true);
    }
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('asks the host before each write, under its own kind (rejecting goes through the feedback dialog)', async () => {
    const { host, calls } = makeHost();
    await render(ITEM, host);
    await click('person-memory-approve-selected');
    await click('person-memory-not-now');
    await click('person-memory-withdraw');
    // Opening the dialog is not a write; submitting it is.
    await click('person-memory-reject');
    expect(calls.authorize).toEqual(['person-memory-approve', 'person-memory-defer', 'person-memory-withdraw']);
    await click('feedback-skip');
    expect(calls.authorize.at(-1)).toBe('reject-feedback');
    expect(storeMocks.approvePersonMemory).toHaveBeenCalledWith('p-person', ['d1', 'd2', 'd3']);
    expect(storeMocks.notNowPersonMemory).toHaveBeenCalledWith('p-person');
    expect(storeMocks.withdrawPersonMemory).toHaveBeenCalledWith('p-person');
    expect(storeMocks.rejectProposal).toHaveBeenCalledWith('p-person', undefined);
  });

  it("sends nothing when the host refuses, including the feedback dialog's submit", async () => {
    const { host, calls } = makeHost({ authorizeWrite: () => false });
    await render(ITEM, host);
    for (const id of ['person-memory-approve-selected', 'person-memory-not-now', 'person-memory-withdraw']) {
      await click(id);
    }
    await click('person-memory-reject');
    await click('feedback-skip');
    for (const mock of Object.values(storeMocks)) expect(mock).not.toHaveBeenCalled();
    expect(calls.requests).toEqual([]);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('locks the four buttons but leaves the picking itself alone', async () => {
    const { host } = makeHost({ writesLocked: true });
    await render(ITEM, host);
    for (const id of [
      'person-memory-approve-selected',
      'person-memory-not-now',
      'person-memory-withdraw',
      'person-memory-reject',
    ]) {
      expect(byTestId<HTMLButtonElement>(id)?.disabled).toBe(true);
    }
    await toggle('黄挺是 21 级');
    expect(checkbox('黄挺是 21 级')?.checked).toBe(false);
  });

  it('reports a changed pick as work in progress, and ends it when the pick is back to the default', async () => {
    const { host, calls } = makeHost();
    await render(ITEM, host);
    expect(calls.editing).toEqual([]);
    await toggle('黄挺是 21 级');
    expect(calls.editing).toEqual([['person-memory-selection', true]]);
    await toggle('黄挺是 21 级');
    expect(calls.editing).toEqual([
      ['person-memory-selection', true],
      ['person-memory-selection', false],
    ]);
  });

  it('treats taking every draft off the list as a choice the user made, not as nothing being edited', async () => {
    const { host, calls } = makeHost();
    await render(ITEM, host);
    for (const text of ['黄挺属于终端用户计算开发部', '黄挺是 21 级', '黄挺在北京']) await toggle(text);
    expect(calls.editing).toEqual([['person-memory-selection', true]]);
    expect(byTestId<HTMLButtonElement>('person-memory-approve-selected')?.disabled).toBe(true);
    await render({ ...ITEM, detail: { ...ITEM.detail, drafts: [...(ITEM.detail.drafts as unknown[])] } }, host);
    expect(checkbox('黄挺是 21 级')?.checked).toBe(false);
    expect(calls.editing).toEqual([['person-memory-selection', true]]);
  });

  it('keeps the picked subset when the same proposal comes back as a fresh copy (a hub refresh)', async () => {
    await render(ITEM);
    await toggle('黄挺是 21 级');
    expect(checkbox('黄挺是 21 级')?.checked).toBe(false);
    await render({ ...ITEM, detail: { ...ITEM.detail, drafts: [...(ITEM.detail.drafts as unknown[])] } });
    expect(checkbox('黄挺是 21 级')?.checked).toBe(false);
    expect(checkbox('黄挺属于终端用户计算开发部')?.checked).toBe(true);
    await click('person-memory-approve-selected');
    expect(storeMocks.approvePersonMemory).toHaveBeenCalledWith('p-person', ['d1', 'd3']);
  });

  it('starts over when the proposal really changed: the drafts that remain are not the ones that were shown', async () => {
    await render(ITEM);
    await toggle('黄挺是 21 级');
    await render({ ...ITEM, detail: { ...ITEM.detail, remainingDraftIds: ['d1', 'd2'] } });
    expect(checkbox('黄挺在北京')).toBeUndefined();
    expect(checkbox('黄挺是 21 级')?.checked).toBe(true);
  });
});
