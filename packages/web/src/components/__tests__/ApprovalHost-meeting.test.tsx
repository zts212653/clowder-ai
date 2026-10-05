/**
 * The F292 meeting-intake card under a host. It writes to its own endpoints, keeps its busy/error state inside, and
 * does not touch the hub store's `deciding`, so the host cannot infer anything from the store: the card reports.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('@/components/useConfirm');

const mockFetchPending = vi.fn(async () => {});
const mockApiFetch = vi.fn();

vi.mock('@/stores/approvalHubStore', () => ({
  useApprovalHubStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ fetchPending: mockFetchPending }),
}));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      threads: [
        {
          id: 'thread-1',
          title: 'F292 产品讨论',
          projectPath: '/workspace/cat-cafe',
          createdBy: 'owner-1',
          participants: ['codex-sol'],
          lastActiveAt: 200,
          createdAt: 100,
        },
        {
          id: 'archive-0',
          title: '历史 Thread 0',
          projectPath: '/workspace/archive',
          createdBy: 'owner-1',
          participants: [],
          lastActiveAt: 90,
          createdAt: 1,
        },
      ],
      currentProjectPath: '/workspace/cat-cafe',
      isLoadingThreads: false,
    }),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));
vi.mock('@/utils/sidebar-thread-snapshot', () => ({ invalidateSidebarProjection: vi.fn(async () => true) }));
vi.mock('@/hooks/useCatData', () => ({
  formatCatName: (cat: { displayName: string }) => cat.displayName,
  useCatData: () => ({
    cats: [
      {
        id: 'codex-sol',
        displayName: '小太阳·砚砚',
        clientId: 'openai',
        defaultModel: 'gpt-5.6-sol',
        avatar: '',
        roleDescription: '',
        personality: '',
        color: { primary: '#000000', secondary: '#ffffff' },
        mentionPatterns: [],
        roster: { family: 'maine-coon', roles: [], lead: true, available: true, evaluation: '' },
      },
    ],
    isLoading: false,
  }),
}));

import { type ApprovalHost, ApprovalHostContext, type ApprovalRequestEvent } from '../ApprovalHost';
import { MeetingIntakeCard } from '../MeetingIntakeCard';
import { ConfirmProvider } from '../useConfirm';

const COMPLETE = {
  proposalId: 'intake-1',
  sourceFeatureId: 'F292' as const,
  requesterCatId: 'system',
  ownerUserId: 'owner-1',
  resolution: 'open' as const,
  materialization: { state: 'not_started' as const },
  summary: '整理会议：Weekly sync',
  detail: {
    revision: 3,
    sourceState: 'ready',
    judgmentState: 'unresolved',
    executionState: 'idle',
    healthState: 'healthy',
    unresolved: [],
    choices: {
      speakerMap: { 1: 'You' },
      context: 'Architecture review',
      destinationHandle: 'host:private-thread:thread-1',
      outputs: ['minutes'],
    },
    metadata: { title: 'Weekly sync' },
    source: { handle: 'feishu://meeting-artifacts/minute/om_1?revision=3' },
  },
  navigation: { state: 'legacy_unanchored' as const },
  inlineApprovable: false,
  decisionMode: 'meeting-intake' as const,
  createdAt: 1,
};
const INCOMPLETE = {
  ...COMPLETE,
  detail: { ...COMPLETE.detail, choices: { ...COMPLETE.detail.choices, context: '' } },
};
const WITH_REPAIR = {
  ...COMPLETE,
  detail: { ...COMPLETE.detail, repair: { code: 'delivery_failed', action: 'retry' as const } },
};

const NO_CAT_REPAIR = {
  ...COMPLETE,
  detail: {
    ...COMPLETE.detail,
    revision: 4,
    judgmentState: 'confirmed',
    executionState: 'failed',
    healthState: 'degraded',
    choices: { ...COMPLETE.detail.choices, destinationHandle: 'host:private-thread:archive-0' },
    repair: { code: 'route_unavailable', action: 'retry' as const, observedAt: 2 },
  },
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

describe('F292 meeting-intake card under a host', () => {
  let container: HTMLDivElement;
  let root: Root;
  const byTestId = <T extends HTMLElement>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`);
  const render = async (item: typeof COMPLETE | typeof WITH_REPAIR | typeof INCOMPLETE, host?: ApprovalHost) =>
    act(async () => {
      const card = React.createElement(ConfirmProvider, null, React.createElement(MeetingIntakeCard, { item }));
      root.render(host ? React.createElement(ApprovalHostContext.Provider, { value: host }, card) : card);
    });
  const click = (id: string) => act(async () => byTestId<HTMLButtonElement>(id)?.click());
  const type = async (id: string, text: string) =>
    act(async () => {
      const field = byTestId<HTMLTextAreaElement>(id);
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, text);
      field?.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const ok = () => ({ ok: true, status: 200, json: async () => ({ intake: { revision: 4 } }) });

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mockApiFetch.mockReset();
    mockFetchPending.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('asks the host before the request, announces it, and reports it settled when the producer says ok', async () => {
    mockApiFetch.mockResolvedValue(ok());
    const { host, calls } = makeHost();
    await render(COMPLETE, host);
    await click('meeting-confirm');
    expect(calls.authorize).toEqual(['meeting-intake']);
    expect(calls.requests).toEqual([
      { phase: 'start', kind: 'meeting-intake' },
      { phase: 'end', kind: 'meeting-intake', outcome: 'settled' },
    ]);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/meeting-intakes/intake-1/confirm', expect.anything());
    expect(mockFetchPending).toHaveBeenCalledTimes(1);
  });

  it('reports the HTTP status the producer actually answered, and still refreshes on a 409 as before', async () => {
    mockApiFetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'revision_conflict' }) });
    const { host, calls } = makeHost();
    await render(COMPLETE, host);
    await click('meeting-confirm');
    expect(calls.requests.at(-1)).toEqual({ phase: 'end', kind: 'meeting-intake', outcome: 'http-error', status: 409 });
    expect(mockFetchPending).toHaveBeenCalledTimes(1);
  });

  it('reports a 403 as the producer answered it, not as something the card guessed', async () => {
    mockApiFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'forbidden' }) });
    const { host, calls } = makeHost();
    await render(COMPLETE, host);
    await click('meeting-confirm');
    expect(calls.requests.at(-1)).toEqual({ phase: 'end', kind: 'meeting-intake', outcome: 'http-error', status: 403 });
    expect(mockFetchPending).not.toHaveBeenCalled();
  });

  it('reports no response at all as a network error, with the card showing its own message', async () => {
    mockApiFetch.mockRejectedValue(new Error('offline'));
    const { host, calls } = makeHost();
    await render(COMPLETE, host);
    await click('meeting-confirm');
    expect(calls.requests.at(-1)).toEqual({ phase: 'end', kind: 'meeting-intake', outcome: 'network-error' });
    expect(container.textContent).toContain('offline');
  });

  it('sends nothing when the host refuses, and does not leave the card stuck busy', async () => {
    const { host, calls } = makeHost({ authorizeWrite: () => false });
    await render(COMPLETE, host);
    await click('meeting-confirm');
    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(calls.requests).toEqual([]);
    expect(byTestId<HTMLButtonElement>('meeting-confirm')?.textContent).toContain('确认并开始整理');
    expect(byTestId<HTMLButtonElement>('meeting-confirm')?.disabled).toBe(false);
  });

  it('guards the repair retry and locks it with the rest', async () => {
    mockApiFetch.mockResolvedValue(ok());
    const guarded = makeHost();
    await render(WITH_REPAIR, guarded.host);
    await click('meeting-retry');
    expect(guarded.calls.authorize).toEqual(['meeting-intake']);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/meeting-intakes/intake-1/retry', expect.anything());

    const locked = makeHost({ writesLocked: true });
    await render(WITH_REPAIR, locked.host);
    expect(byTestId<HTMLButtonElement>('meeting-retry')?.disabled).toBe(true);
    expect(byTestId<HTMLButtonElement>('meeting-dismiss')?.disabled).toBe(true);
    expect(byTestId<HTMLButtonElement>('meeting-confirm')?.disabled).toBe(true);
  });

  it('keeps the form editable while locked, and holds what was typed', async () => {
    const { host } = makeHost({ writesLocked: true });
    await render(COMPLETE, host);
    await click('meeting-edit-toggle');
    await type('meeting-context', 'Architecture review, second pass');
    expect(byTestId<HTMLTextAreaElement>('meeting-context')?.value).toBe('Architecture review, second pass');
    expect(byTestId<HTMLButtonElement>('meeting-confirm')?.disabled).toBe(true);
  });

  it('reports the form as being used once the user opens it, before a single character changes', async () => {
    const { host, calls } = makeHost();
    await render(COMPLETE, host);
    expect(calls.editing).toEqual([]);
    await click('meeting-edit-toggle');
    expect(calls.editing).toEqual([['meeting-form', true]]);
    await click('meeting-edit-toggle');
    expect(calls.editing).toEqual([
      ['meeting-form', true],
      ['meeting-form', false],
    ]);
  });

  it('reports a form that is open by default as used from the moment focus goes into it', async () => {
    const { host, calls } = makeHost();
    await render(INCOMPLETE, host);
    expect(byTestId('meeting-context')).not.toBeNull();
    expect(calls.editing).toEqual([]);
    await act(async () => byTestId<HTMLTextAreaElement>('meeting-context')?.focus());
    expect(calls.editing).toEqual([['meeting-form', true]]);
  });

  it('keeps reporting while the form is open, even after typing is put back to what the proposal says', async () => {
    const { host, calls } = makeHost();
    await render(COMPLETE, host);
    await click('meeting-edit-toggle');
    await type('meeting-context', 'something else');
    await type('meeting-context', 'Architecture review');
    expect(calls.editing).toEqual([['meeting-form', true]]);
    await click('meeting-edit-toggle');
    expect(calls.editing.at(-1)).toEqual(['meeting-form', false]);
  });

  it('reports a changed form that is then collapsed as still work in progress', async () => {
    const { host, calls } = makeHost();
    await render(COMPLETE, host);
    await click('meeting-edit-toggle');
    await type('meeting-context', 'something else');
    await click('meeting-edit-toggle');
    expect(calls.editing).toEqual([['meeting-form', true]]);
  });

  describe('saving the destination cat and retrying is two producer writes, each behind the guard', () => {
    const patched = { ok: true, status: 200, json: async () => ({ preferredCats: ['codex-sol'] }) };
    const retried = { ok: true, status: 200, json: async () => ({ intake: { revision: 7 } }) };
    const bind = async () => {
      await click('meeting-workflow-cat-codex-sol');
      await click('meeting-bind-cat-retry');
    };

    it('asks the host before the thread save and again before the retry, and announces one request', async () => {
      mockApiFetch.mockResolvedValueOnce(patched).mockResolvedValueOnce(retried);
      const { host, calls } = makeHost();
      await render(NO_CAT_REPAIR, host);
      await bind();
      expect(calls.authorize).toEqual(['meeting-intake', 'meeting-intake']);
      expect(mockApiFetch.mock.calls.map(([url]) => url)).toEqual([
        '/api/threads/archive-0',
        '/api/meeting-intakes/intake-1/retry',
      ]);
      expect(calls.requests).toEqual([
        { phase: 'start', kind: 'meeting-intake' },
        { phase: 'end', kind: 'meeting-intake', outcome: 'settled' },
      ]);
    });

    it('does not send the retry when the host refuses it after the thread save went through', async () => {
      mockApiFetch.mockResolvedValueOnce(patched).mockResolvedValueOnce(retried);
      let asked = 0;
      const { host, calls } = makeHost({ authorizeWrite: () => ++asked === 1 });
      await render(NO_CAT_REPAIR, host);
      await bind();
      expect(mockApiFetch.mock.calls.map(([url]) => url)).toEqual(['/api/threads/archive-0']);
      expect(calls.requests.at(-1)).toMatchObject({ phase: 'end', kind: 'meeting-intake' });
      expect(container.textContent).toContain('负责猫猫已经保存');
      expect(container.textContent).toContain('没有重新投递');
    });

    it('does not send the retry when the host locks while the thread save is still in flight', async () => {
      let answerPatch: (value: typeof patched) => void = () => undefined;
      mockApiFetch.mockImplementationOnce(() => new Promise((resolve) => (answerPatch = resolve)));
      mockApiFetch.mockResolvedValueOnce(retried);
      let locked = false;
      const { host, calls } = makeHost({ authorizeWrite: () => !locked });
      await render(NO_CAT_REPAIR, host);
      await click('meeting-workflow-cat-codex-sol');
      await click('meeting-bind-cat-retry');
      expect(mockApiFetch.mock.calls.map(([url]) => url)).toEqual(['/api/threads/archive-0']);
      expect(calls.requests).toEqual([{ phase: 'start', kind: 'meeting-intake' }]);

      locked = true;
      await act(async () => answerPatch(patched));

      expect(mockApiFetch.mock.calls.map(([url]) => url)).toEqual(['/api/threads/archive-0']);
      expect(calls.requests.at(-1)).toMatchObject({ phase: 'end', kind: 'meeting-intake' });
      expect(byTestId('meeting-bind-cat-retry')).not.toBeNull();
      expect(container.textContent).toContain('没有重新投递');
    });

    it('sends nothing at all when the host refuses the first write', async () => {
      const { host } = makeHost({ authorizeWrite: () => false });
      await render(NO_CAT_REPAIR, host);
      await bind();
      expect(mockApiFetch).not.toHaveBeenCalled();
    });

    it('without a host both writes go out as before', async () => {
      mockApiFetch.mockResolvedValueOnce(patched).mockResolvedValueOnce(retried);
      await render(NO_CAT_REPAIR);
      await bind();
      expect(mockApiFetch.mock.calls.map(([url]) => url)).toEqual([
        '/api/threads/archive-0',
        '/api/meeting-intakes/intake-1/retry',
      ]);
    });
  });

  it('without a host it behaves as before: the request is made and nothing else happens', async () => {
    mockApiFetch.mockResolvedValue(ok());
    await render(COMPLETE);
    await click('meeting-confirm');
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(mockFetchPending).toHaveBeenCalledTimes(1);
  });
});
