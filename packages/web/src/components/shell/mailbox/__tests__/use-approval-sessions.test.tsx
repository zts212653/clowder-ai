/**
 * F322 S3-2b-1c: the React side of the sessions driver. It owns nothing the driver does not; it feeds the driver the three
 * things only React/zustand know about: the Approval Hub store's attempt records, the moment a unified read settles, and
 * the read hook's live count of reads started (so "a newer read is on its way" is true the instant it starts, before React
 * has re-rendered).
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionAttempt } from '@/stores/approval-decision-attempts';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import type { MailboxRead } from '../../unified-mailbox-state';
import type { UnifiedAttentionView } from '../../use-unified-attention';
import { sessionKey } from '../approval-sessions';
import { useApprovalSessions } from '../use-approval-sessions';
import { approvalRow, OWNER, okRead, storeItem, visibleApproval } from './mailbox-fixtures';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));

/** The repo renders hooks with react-dom directly (no testing-library): a harness component that records what the hook returned. */
function renderHook<Props, Result>(useHook: (props: Props) => Result, initialProps: Props) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const result = { current: undefined as unknown as Result };
  function Harness({ props }: { props: Props }) {
    result.current = useHook(props);
    return null;
  }
  act(() => root.render(<Harness props={initialProps} />));
  return {
    result,
    rerender(props: Props) {
      act(() => root.render(<Harness props={props} />));
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const item = storeItem();
const KEY = sessionKey(OWNER, { sourceFeatureId: 'F128', proposalId: 'p-1' });
const seed = { ownerUserId: OWNER, decisionRef: 'approval:p-1', approval: visibleApproval(item) };

function json(body: unknown, status = 200) {
  return Promise.resolve(Response.json(body, { status }));
}

/** A read hook view whose count can move on its own, as the real hook's does. */
function fakeView() {
  const state = { started: 1, result: okRead([approvalRow(item)]) as MailboxRead, generation: 1 as number | null };
  const refetch = vi.fn(() => {
    state.started += 1;
    // The real hook sets state here, and the next render shows loading; the count has moved already.
  });
  const view = (): UnifiedAttentionView => ({
    result: state.result,
    staleRead: null,
    refetch,
    readsStarted: () => state.started,
    resultGeneration: state.generation,
  });
  return { state, refetch, view };
}

const attempt = (attemptId: number, phase: DecisionAttempt['state']): DecisionAttempt => ({
  attemptId,
  action: 'approve',
  sourceFeatureId: 'F128',
  createdAt: item.createdAt,
  state: phase,
});

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockReset();
  useApprovalHubStore.setState({ items: [item], count: 1, decisionAttempts: {}, error: null, isLoading: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useApprovalHubStore.setState({ items: [], count: 0, decisionAttempts: {} });
});

describe('useApprovalSessions', () => {
  it('gives the same driver on every render', () => {
    const fake = fakeView();
    const { result, rerender } = renderHook(({ view }: { view: UnifiedAttentionView }) => useApprovalSessions(view), {
      view: fake.view(),
    });
    const first = result.current;
    rerender({ view: fake.view() });
    expect(result.current).toBe(first);
  });

  it('feeds the driver the Approval Hub store’s attempt records', () => {
    const fake = fakeView();
    const { result } = renderHook(() => useApprovalSessions(fake.view()), undefined);
    act(() => {
      result.current.open(seed);
    });
    act(() => {
      useApprovalHubStore.setState({ decisionAttempts: { 'p-1': attempt(1, { phase: 'submitting' }) } });
    });
    expect(result.current.get(KEY)?.model.state).toEqual({ kind: 'writing', attemptId: 1 });
  });

  it('a write’s end starts one unified read and one store refresh', async () => {
    mocks.apiFetch.mockImplementation(() => json({ items: [item], count: 1 }));
    const fake = fakeView();
    const { result } = renderHook(() => useApprovalSessions(fake.view()), undefined);
    act(() => {
      result.current.open(seed);
    });
    act(() => {
      useApprovalHubStore.setState({
        decisionAttempts: { 'p-1': attempt(1, { phase: 'response_received', status: 200, ok: true }) },
      });
    });
    expect(fake.refetch).toHaveBeenCalledTimes(1);
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/approval-hub/pending');
  });

  it('judges the read once it settles and React has committed it', async () => {
    mocks.apiFetch.mockImplementation((path: string) =>
      path.startsWith('/api/approval-hub/settled')
        ? json({
            items: [
              {
                proposalId: 'p-1',
                sourceFeatureId: 'F128',
                ownerUserId: OWNER,
                resolution: 'accepted',
                decidedAt: 42,
                decidedBy: OWNER,
              },
            ],
            count: 1,
          })
        : json({ items: [], count: 0 }),
    );
    const fake = fakeView();
    const { result, rerender } = renderHook(({ view }: { view: UnifiedAttentionView }) => useApprovalSessions(view), {
      view: fake.view(),
    });
    act(() => {
      result.current.open(seed);
    });
    act(() => {
      useApprovalHubStore.setState({
        decisionAttempts: { 'p-1': attempt(1, { phase: 'response_received', status: 200, ok: true }) },
      });
    });
    // The new read answers: it no longer lists the approval.
    fake.state.result = okRead([]);
    fake.state.generation = fake.state.started;
    await act(async () => {
      rerender({ view: fake.view() });
    });
    await vi.waitFor(() => expect(result.current.get(KEY)?.model.state.kind).toBe('decided'));
    expect(result.current.get(KEY)?.model.state).toMatchObject({
      kind: 'decided',
      terminal: { resolution: 'accepted', decidedAt: 42 },
    });
  });

  it('knows a newer read has begun the moment it starts, before React shows it', () => {
    const fake = fakeView();
    const { result } = renderHook(() => useApprovalSessions(fake.view()), undefined);
    act(() => {
      result.current.open(seed);
    });
    expect(result.current.authorize(KEY)).toBe(true);
    // A re-read starts (an invalidation event): the count moves now; the component has not re-rendered yet.
    fake.state.started += 1;
    expect(result.current.authorize(KEY)).toBe(false);
  });

  it('stops listening to the store when it goes away', () => {
    const fake = fakeView();
    const { result, unmount } = renderHook(() => useApprovalSessions(fake.view()), undefined);
    const sessions = result.current;
    act(() => {
      sessions.open(seed);
    });
    unmount();
    act(() => {
      useApprovalHubStore.setState({ decisionAttempts: { 'p-1': attempt(1, { phase: 'submitting' }) } });
    });
    expect(sessions.get(KEY)?.model.state).toEqual({ kind: 'idle' });
  });
});
