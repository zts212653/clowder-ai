/**
 * The host contract of the original approval cards (generic, feedback dialog, F260 conflict panel).
 *
 * Without a provider a card behaves exactly as before (the existing ApprovalItemCard-* suites pin that). With one, the host
 * is asked right before every producer write, can lock writes (editing, cancel and Escape stay), is told what the user is
 * in the middle of, and sees each write start and end.
 */
import type { ApprovalHubItem, EntityConflictContext } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { anchoredApprovalNavigation } from '@/test-support/approval-navigation';

const order = vi.hoisted(() => [] as string[]);
const storeMocks = vi.hoisted(() => ({
  approveProposal: vi.fn(),
  rejectProposal: vi.fn(),
  resolveEntityConflict: vi.fn(),
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
      approveProposal: storeMocks.approveProposal,
      rejectProposal: storeMocks.rejectProposal,
      resolveEntityConflict: storeMocks.resolveEntityConflict,
      deciding: storeMocks.deciding,
      error: null,
    }),
}));
vi.mock('@/utils/scrollToMessage', () => ({ scrollToMessage: vi.fn() }));
vi.mock('@/utils/teleport', () => ({ planTeleport: () => ({}), kickTeleportResolve: vi.fn() }));
vi.mock('../ThreadSidebar/thread-navigation', () => ({ pushThreadRouteWithHistory: vi.fn() }));

import { type ApprovalHost, ApprovalHostContext, type ApprovalRequestEvent, useGuardedWrite } from '../ApprovalHost';
import { ApprovalItemCard } from '../ApprovalItemCard';

const base = {
  navigation: anchoredApprovalNavigation('thread-src'),
  requesterCatId: 'opus',
  ownerUserId: 'owner-1',
  resolution: 'open',
  materialization: { state: 'not_started' },
  createdAt: Date.now() - 60_000,
} as const;

const GENERIC: ApprovalHubItem = {
  ...base,
  proposalId: 'p-generic',
  sourceFeatureId: 'F128',
  summary: 'New thread: 记一条品味',
  detail: {},
  inlineApprovable: true,
};
const FEEDBACK: ApprovalHubItem = {
  ...base,
  proposalId: 'p-handoff',
  sourceFeatureId: 'F225',
  summary: '接续 F281 Phase B',
  detail: { done: 'Phase A landed', nextSteps: 'capture feedback' },
  inlineApprovable: false,
};
const CONFLICT: EntityConflictContext = {
  version: 1,
  reason: 'existing-entity-change',
  fingerprint: 'a'.repeat(64),
  incoming: {
    entityId: 'concept:沉迷护栏',
    entityType: 'concept',
    canonicalName: '猫猫安全护栏',
    aliases: ['猫猫安全护栏'],
    stance: 'endorsed',
    visibilityScope: 'workspace',
    status: 'active',
  },
  candidates: [
    {
      entityId: 'concept:沉迷护栏',
      entityType: 'concept',
      canonicalName: '防AI沉迷护栏',
      aliases: ['沉迷护栏'],
      stance: 'endorsed',
      visibilityScope: 'workspace',
      status: 'active',
    },
  ],
  conflictingSurfaces: ['沉迷护栏'],
  canonicalReplacementRequiredFor: [],
  allowedActions: ['merge-aliases', 'replace', 'reject'],
};
const ENTITY: ApprovalHubItem = {
  ...base,
  proposalId: 'p-entity',
  sourceFeatureId: 'F260',
  summary: 'Entity proposal: 沉迷护栏',
  detail: { entityId: 'concept:沉迷护栏', canonicalName: '猫猫安全护栏', conflict: CONFLICT },
  inlineApprovable: true,
  expiresAt: Date.now() + 86_400_000,
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
      order.push(`authorize:${kind}`);
      return true;
    },
    reportEditing: (source, editing) => calls.editing.push([source, editing]),
    reportRequest: (event) => {
      calls.requests.push(event);
      order.push(`${event.phase}:${event.kind}`);
    },
    ...overrides,
  };
  return { host, calls };
}

describe('original approval cards under a host', () => {
  let container: HTMLDivElement;
  let root: Root;
  const byTestId = <T extends HTMLElement>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`);
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
    order.length = 0;
    storeMocks.deciding = {};
    for (const mock of [storeMocks.approveProposal, storeMocks.rejectProposal, storeMocks.resolveEntityConflict]) {
      mock.mockReset();
      mock.mockImplementation(async () => {
        order.push('store');
        return true;
      });
    }
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  describe('the write guard', () => {
    it('is asked right before approve, then the write is announced, made and reported — in that order', async () => {
      const { host, calls } = makeHost();
      await render(GENERIC, host);
      await click('approve-btn');
      expect(order).toEqual(['authorize:approve', 'start:approve', 'store', 'end:approve']);
      expect(calls.requests[1]).toMatchObject({ phase: 'end', kind: 'approve', outcome: 'settled' });
      expect(storeMocks.approveProposal).toHaveBeenCalledWith('p-generic');
    });

    it('sends nothing when the host refuses, even though the button looked pressable', async () => {
      const { host, calls } = makeHost({ authorizeWrite: () => false });
      await render(GENERIC, host);
      await click('approve-btn');
      await click('reject-btn');
      expect(storeMocks.approveProposal).not.toHaveBeenCalled();
      expect(storeMocks.rejectProposal).not.toHaveBeenCalled();
      expect(calls.requests).toEqual([]);
    });

    it('reports a producer write that throws as a network error, and rethrows it for the card to handle', async () => {
      const { host, calls } = makeHost();
      let guarded: ReturnType<typeof useGuardedWrite> | undefined;
      function Probe() {
        guarded = useGuardedWrite();
        return null;
      }
      await act(async () =>
        root.render(
          <ApprovalHostContext.Provider value={host}>
            <Probe />
          </ApprovalHostContext.Provider>,
        ),
      );
      const failure = new Error('offline');
      await expect(guarded?.('approve', () => Promise.reject(failure))).rejects.toBe(failure);
      expect(calls.requests).toEqual([
        { phase: 'start', kind: 'approve' },
        { phase: 'end', kind: 'approve', outcome: 'network-error' },
      ]);
    });

    it('guards a plain reject, an entity resolution and the feedback-dialog submit, each under its own kind', async () => {
      const first = makeHost();
      await render(GENERIC, first.host);
      await click('reject-btn');
      expect(first.calls.authorize).toEqual(['reject']);

      const second = makeHost();
      await render(ENTITY, second.host);
      await click('resolve-merge-aliases');
      expect(second.calls.authorize).toEqual(['entity-resolve']);
      expect(storeMocks.resolveEntityConflict).toHaveBeenCalledTimes(1);

      const third = makeHost();
      await render(FEEDBACK, third.host);
      await click('reject-btn');
      await act(async () => container.querySelector<HTMLInputElement>('input[value="wrong_lane"]')?.click());
      await click('feedback-submit');
      expect(third.calls.authorize).toEqual(['reject-feedback']);
      expect(storeMocks.rejectProposal).toHaveBeenLastCalledWith('p-handoff', { reasonCode: 'wrong_lane' });
    });
  });

  describe('locked writes', () => {
    it('disable the producer buttons but leave the card readable', async () => {
      const { host } = makeHost({ writesLocked: true });
      await render(GENERIC, host);
      expect(byTestId<HTMLButtonElement>('approve-btn')?.disabled).toBe(true);
      expect(byTestId<HTMLButtonElement>('reject-btn')?.disabled).toBe(true);
      expect(container.textContent).toContain('记一条品味');
    });

    it('disable the entity-conflict actions too', async () => {
      const { host } = makeHost({ writesLocked: true });
      await render(ENTITY, host);
      expect(byTestId<HTMLButtonElement>('resolve-merge-aliases')?.disabled).toBe(true);
      expect(byTestId<HTMLButtonElement>('conflict-reject')?.disabled).toBe(true);
    });

    // The realistic order: the dialog is already open when a re-read starts and the host locks. Opening one while locked is
    // not possible (the reject button is disabled), which is the point.
    const openDialogThenLock = async () => {
      const state = { locked: false };
      const { host, calls } = makeHost({ authorizeWrite: () => !state.locked });
      const view = (item: ApprovalHubItem) => (
        <ApprovalHostContext.Provider value={{ ...host, writesLocked: state.locked }}>
          <ApprovalItemCard item={item} />
        </ApprovalHostContext.Provider>
      );
      await act(async () => root.render(view(FEEDBACK)));
      await click('reject-btn');
      await act(async () => container.querySelector<HTMLInputElement>('input[value="other"]')?.click());
      const type = async (text: string) =>
        act(async () => {
          const detail = container.querySelector<HTMLTextAreaElement>('textarea');
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(detail, text);
          detail?.dispatchEvent(new Event('input', { bubbles: true }));
        });
      await type('还没想清楚');
      return {
        calls,
        type,
        lock: async (locked: boolean) => {
          state.locked = locked;
          await act(async () => root.render(view({ ...FEEDBACK })));
        },
      };
    };

    it('keep the feedback dialog usable for editing, cancel and Escape, and only refuse the submit and the skip', async () => {
      const { calls, type, lock } = await openDialogThenLock();
      await lock(true);

      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
      expect(byTestId('feedback-dialog-locked')).not.toBeNull();
      expect(byTestId<HTMLButtonElement>('feedback-submit')?.disabled).toBe(true);
      expect(byTestId<HTMLButtonElement>('feedback-skip')?.disabled).toBe(true);
      // What was typed is still there, and typing still works while locked.
      expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('还没想清楚');
      await type('还没想清楚，再想想');
      expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('还没想清楚，再想想');

      await click('feedback-submit');
      await click('feedback-skip');
      expect(storeMocks.rejectProposal).not.toHaveBeenCalled();
      expect(calls.requests).toEqual([]);
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();

      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(container.querySelector('[role="dialog"]')).toBeNull();
    });

    it('unlock the submit again with what was typed still there', async () => {
      const { lock } = await openDialogThenLock();
      await lock(true);
      expect(byTestId<HTMLButtonElement>('feedback-submit')?.disabled).toBe(true);
      await lock(false);
      expect(byTestId('feedback-dialog-locked')).toBeNull();
      expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('还没想清楚');
      expect(byTestId<HTMLButtonElement>('feedback-submit')?.disabled).toBe(false);
      await click('feedback-submit');
      expect(storeMocks.rejectProposal).toHaveBeenCalledWith('p-handoff', {
        reasonCode: 'other',
        detail: '还没想清楚',
      });
    });
  });

  describe('what the user is in the middle of', () => {
    it('is reported while the feedback dialog is open, and ends when it closes', async () => {
      const { host, calls } = makeHost();
      await render(FEEDBACK, host);
      expect(calls.editing).toEqual([]);
      await click('reject-btn');
      expect(calls.editing).toEqual([['feedback-dialog', true]]);
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(calls.editing).toEqual([
        ['feedback-dialog', true],
        ['feedback-dialog', false],
      ]);
    });

    it('is ended when the card goes away mid-edit, so a host never keeps a draft that is gone', async () => {
      const { host, calls } = makeHost();
      await render(FEEDBACK, host);
      await click('reject-btn');
      act(() => root.render(<div />));
      expect(calls.editing.at(-1)).toEqual(['feedback-dialog', false]);
    });

    it('keeps the typed reason through a re-render with a fresh copy of the same item', async () => {
      const { host } = makeHost();
      await render(FEEDBACK, host);
      await click('reject-btn');
      await act(async () => container.querySelector<HTMLInputElement>('input[value="wrong_lane"]')?.click());
      await render({ ...FEEDBACK, detail: { ...FEEDBACK.detail } }, host);
      expect(container.querySelector<HTMLInputElement>('input[value="wrong_lane"]')?.checked).toBe(true);
    });

    it('is reported by the entity-conflict panel once a replacement is typed', async () => {
      const surface: EntityConflictContext = {
        ...CONFLICT,
        reason: 'surface-collision',
        fingerprint: 'b'.repeat(64),
        canonicalReplacementRequiredFor: ['concept:沉迷护栏'],
        allowedActions: ['correct', 'transfer', 'polysemy', 'reject'],
      };
      const { host, calls } = makeHost();
      await render({ ...ENTITY, detail: { ...ENTITY.detail, conflict: surface } }, host);
      expect(calls.editing).toEqual([]);
      const input = byTestId<HTMLInputElement>('canonical-replacement-concept:沉迷护栏');
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, '新名字');
        input?.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(calls.editing).toEqual([['entity-conflict', true]]);
    });
  });

  describe('when the host itself is replaced while a card is in use', () => {
    const renderUnder = (item: ApprovalHubItem, host: ApprovalHost) => render(item, host);

    it('keeps a write with the host that began it: that host sees its start and its end, the new one sees neither', async () => {
      const a = makeHost();
      const b = makeHost();
      let release: () => void = () => undefined;
      storeMocks.approveProposal.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            release = () => resolve(true);
          }),
      );
      await renderUnder(GENERIC, a.host);
      await click('approve-btn');
      expect(a.calls.requests).toEqual([{ phase: 'start', kind: 'approve' }]);

      await renderUnder(GENERIC, b.host);
      await act(async () => release());

      expect(a.calls.requests).toEqual([
        { phase: 'start', kind: 'approve' },
        { phase: 'end', kind: 'approve', outcome: 'settled' },
      ]);
      expect(b.calls.requests).toEqual([]);
    });

    it('ends an edit with the host that began it, and starts it again with the new one, so each sees a balanced pair', async () => {
      const a = makeHost();
      const b = makeHost();
      await renderUnder(FEEDBACK, a.host);
      await click('reject-btn');
      expect(a.calls.editing).toEqual([['feedback-dialog', true]]);

      await renderUnder(FEEDBACK, b.host);
      expect(a.calls.editing).toEqual([
        ['feedback-dialog', true],
        ['feedback-dialog', false],
      ]);
      expect(b.calls.editing).toEqual([['feedback-dialog', true]]);

      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(a.calls.editing).toEqual([
        ['feedback-dialog', true],
        ['feedback-dialog', false],
      ]);
      expect(b.calls.editing).toEqual([
        ['feedback-dialog', true],
        ['feedback-dialog', false],
      ]);
    });

    it('does not restart an edit when only the lock changes and the reporter is the same', async () => {
      const a = makeHost();
      await renderUnder(FEEDBACK, a.host);
      await click('reject-btn');
      await renderUnder(FEEDBACK, { ...a.host, writesLocked: true });
      await renderUnder(FEEDBACK, { ...a.host, writesLocked: false });
      expect(a.calls.editing).toEqual([['feedback-dialog', true]]);
    });
  });

  describe('without a host', () => {
    it('approves exactly as before: no guard, no reports, the store is called directly', async () => {
      await render(GENERIC);
      await click('approve-btn');
      expect(order).toEqual(['store']);
      expect(storeMocks.approveProposal).toHaveBeenCalledWith('p-generic');
    });
  });
});
