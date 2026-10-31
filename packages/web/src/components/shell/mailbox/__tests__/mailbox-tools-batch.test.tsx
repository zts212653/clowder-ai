import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DecisionAttemptState } from '@/stores/approval-decision-attempts';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import type { UnifiedAttentionView } from '../../use-unified-attention';
import type { ApprovalSessions } from '../approval-sessions';
import { MailboxApprovalTools } from '../MailboxApprovalTools';
import { useApprovalSessions } from '../use-approval-sessions';
import { approvalRow, OWNER, okRead, storeItem } from './mailbox-fixtures';

const mocked = vi.hoisted(() => ({ fetch: vi.fn(), back: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocked.fetch }));
vi.mock('@/hooks/useCatNameResolver', () => ({ useCatNameResolver: () => (id: string) => id }));
vi.mock('@/stores/chatStore', () => {
  const useChatStore = (select: (s: Record<string, unknown>) => unknown) => select({ threads: [] });
  useChatStore.getState = () => ({ currentThreadId: null, threads: [] });
  return { useChatStore };
});
vi.mock('@/utils/scrollToMessage', () => ({ scrollToMessage: vi.fn() }));
vi.mock('@/utils/teleport', () => ({ planTeleport: () => ({}), kickTeleportResolve: vi.fn() }));
vi.mock('../../../ThreadSidebar/thread-navigation', () => ({ pushThreadRouteWithHistory: vi.fn() }));
const first = storeItem({
  proposalId: 'first',
  sourceFeatureId: 'F193',
  detail: { content: '第一件工作', targetCats: ['codex61-sol'] },
});
const second = storeItem({
  proposalId: 'second',
  sourceFeatureId: 'F193',
  detail: { content: '第二件工作', targetCats: ['codex61-sol'] },
});
const form = storeItem({ proposalId: 'form', inlineApprovable: false });
const items = [first, second, form];
let root: Root;
let container: HTMLDivElement;
let sessions: ApprovalSessions;
let generation = 1;
const view: UnifiedAttentionView = {
  result: okRead(items.map((item) => approvalRow(item))),
  staleRead: null,
  resultGeneration: 1,
  readsStarted: () => generation,
  refetch: () => {
    generation++;
  },
};
function Wrapper() {
  sessions = useApprovalSessions(view);
  return (
    <MailboxApprovalTools section="tools" view={view} sessions={sessions} onBack={mocked.back} onOpenPlace={() => {}} />
  );
}
const click = (id: string) =>
  act(async () => container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)?.click());
function recordAttempt(item: typeof first, state: DecisionAttemptState) {
  useApprovalHubStore.setState((store) => ({
    decisionAttempts: {
      ...store.decisionAttempts,
      [item.proposalId]: {
        attemptId: 1,
        action: 'approve',
        sourceFeatureId: item.sourceFeatureId,
        createdAt: item.createdAt,
        state,
      },
    },
  }));
}
const noPermission: DecisionAttemptState = { phase: 'response_received', status: 403, ok: false };
async function holdFirst(kind: 'unknown' | 'writing' | 'no_permission') {
  await act(async () => {
    recordAttempt(
      first,
      kind === 'writing'
        ? { phase: 'submitting' }
        : kind === 'no_permission'
          ? noPermission
          : { phase: 'transport_unknown' },
    );
    if (kind === 'unknown') {
      // Complete the real driver's post-write authoritative read: still listed never makes a lost answer safe to resend.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      view.resultGeneration = generation;
      sessions.readSettled();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      root.render(<Wrapper />);
    }
  });
  expect(sessions.list().find((session) => session.address.proposalId === 'first')?.model.state).toMatchObject(
    kind === 'unknown' ? { kind: 'still_open', write: { outcome: 'unknown' } } : { kind },
  );
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocked.fetch.mockReset();
  mocked.back.mockReset();
  generation = 1;
  view.resultGeneration = 1;
  useApprovalHubStore.setState({
    items,
    count: 3,
    error: null,
    isLoading: false,
    pendingReadAvailable: true,
    selectedIds: new Set(),
    deciding: {},
    decisionAttempts: {},
    batchResults: [],
  });
  mocked.fetch.mockImplementation(async (path: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? Response.json({ ok: true })
      : path === '/api/approval-hub/pending'
        ? Response.json({ items, count: 3 })
        : Response.json({}),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Wrapper />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('keeps original safe eligibility, sends the selected original producer writes once, and returns to canonical confirmation', async () => {
  await click('approval-batch-select-toggle');
  expect([...useApprovalHubStore.getState().selectedIds]).toEqual(['first', 'second']);
  await click('approval-batch-approve');
  const posts = mocked.fetch.mock.calls.filter(([, init]) => init?.method === 'POST').map(([path]) => path);
  expect(posts).toEqual(['/api/dispatch-proposals/first/approve', '/api/dispatch-proposals/second/approve']);
  expect(useApprovalHubStore.getState().selectedIds.size).toBe(0);
  expect(mocked.back).toHaveBeenCalledTimes(1);
  expect(
    sessions
      .list()
      .filter((session) => ['first', 'second'].includes(session.address.proposalId))
      .every((session) => session.model.state.kind === 'confirming'),
  ).toBe(true);
  expect(
    sessions.list().some((session) => session.ownerUserId !== OWNER || session.model.state.kind === 'decided'),
  ).toBe(false);
});
it('sends nothing when a selected proposal changed before the native click was rendered again', async () => {
  await click('approval-batch-select-toggle');
  const button = container.querySelector<HTMLButtonElement>('[data-testid="approval-batch-approve"]');
  await act(async () => {
    useApprovalHubStore.setState({
      items: [{ ...first, detail: { ...first.detail, content: '变更后的工作' } }, second, form],
    });
    button?.click();
  });
  expect(mocked.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
});
it.each([
  'unknown',
  'writing',
  'no_permission',
] as const)('excludes a reachable %s session from 全选可操作 while its canonical row stays visible', async (kind) => {
  await holdFirst(kind);
  await click('approval-batch-select-toggle');
  expect([...useApprovalHubStore.getState().selectedIds]).toEqual(['second']);
  expect(container.querySelector('[data-testid="mailbox-tools-item-first"]')).not.toBeNull();
  expect(mocked.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
});
it('reacts to a session-only permission change by withdrawing that selection and its actionable count', async () => {
  await click('approval-batch-select-toggle');
  expect([...useApprovalHubStore.getState().selectedIds]).toEqual(['first', 'second']);
  await holdFirst('no_permission');
  expect([...useApprovalHubStore.getState().selectedIds]).toEqual(['second']);
  expect(container.querySelector('[data-testid="approval-batch-select-toggle"]')?.textContent).toBe('取消选择 (1)');
});
it.each([
  first,
  second,
])('refuses the whole mixed batch when $proposalId becomes held immediately before the native press', async (held) => {
  await click('approval-batch-select-toggle');
  const button = container.querySelector<HTMLButtonElement>('[data-testid="approval-batch-approve"]');
  expect(button).not.toBeNull();
  await act(async () => {
    recordAttempt(held, noPermission);
    button?.click();
    // The press itself must neither clear the selection nor start the other writer; React can then withdraw the held row.
    expect([...useApprovalHubStore.getState().selectedIds]).toEqual(['first', 'second']);
    expect(mocked.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    expect(mocked.back).not.toHaveBeenCalled();
  });
  expect(container.querySelector('[data-testid="mailbox-batch-notice"]')?.textContent).toContain('本次没有提交');
});
it('finishes every original session authorization before starting any selected producer write', async () => {
  await click('approval-batch-select-toggle');
  const authorize = sessions.authorize;
  vi.spyOn(sessions, 'authorize').mockImplementation((key, options) =>
    key.endsWith('|second') ? false : authorize(key, options),
  );
  await click('approval-batch-approve');
  expect(mocked.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  expect([...useApprovalHubStore.getState().selectedIds]).toEqual(['first', 'second']);
  expect(mocked.back).not.toHaveBeenCalled();
  expect(container.querySelector('[data-testid="mailbox-batch-notice"]')?.textContent).toContain('本次没有提交');
});
