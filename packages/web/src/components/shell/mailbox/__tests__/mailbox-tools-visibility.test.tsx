import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import type { UnifiedAttentionView } from '../../use-unified-attention';
import { MailboxApprovalTools } from '../MailboxApprovalTools';
import { useApprovalSessions } from '../use-approval-sessions';
import { approvalRow, okRead, storeItem } from './mailbox-fixtures';

const mocked = vi.hoisted(() => ({ fetch: vi.fn() }));
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
let root: Root;
let container: HTMLDivElement;
const proposal = storeItem({
  sourceFeatureId: 'F193',
  summary: '派给 codex61-sol：第一件工作',
  detail: { content: '第一件工作', targetCats: ['codex61-sol'] },
});
async function mount(kind: 'expired' | 'mismatch' | 'missing' | 'unavailable' | 're-reading') {
  const canonical = kind === 'expired' ? { ...proposal, expiresAt: Date.now() - 1_000 } : proposal;
  const copies =
    kind === 'missing'
      ? []
      : [{ ...canonical, ...(kind === 'mismatch' ? { detail: { ...canonical.detail, content: '已改版本' } } : {}) }];
  useApprovalHubStore.setState({
    items: copies,
    error: null,
    isLoading: false,
    pendingReadAvailable: kind !== 'unavailable',
    selectedIds: new Set(),
    deciding: {},
    decisionAttempts: {},
    batchResults: [],
  });
  mocked.fetch.mockImplementation(async () =>
    kind === 'unavailable'
      ? new Response(null, { status: 503 })
      : Response.json({ items: copies, count: copies.length }),
  );
  const view: UnifiedAttentionView = {
    result: okRead([approvalRow(canonical)]),
    resultGeneration: 1,
    staleRead: null,
    readsStarted: () => 1,
    refetch: vi.fn(),
  };
  if (kind === 're-reading') {
    const previous = view.result;
    if (previous.kind !== 'ok') throw new Error('Expected the verified same-owner fixture');
    view.result = { kind: 'loading' };
    view.staleRead = previous.read;
    view.resultGeneration = null;
    view.readsStarted = () => 2;
  }
  function Wrapper() {
    const sessions = useApprovalSessions(view);
    return (
      <MailboxApprovalTools section="tools" view={view} sessions={sessions} onBack={() => {}} onOpenPlace={() => {}} />
    );
  }
  await act(async () => root.render(<Wrapper />));
  await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocked.fetch.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it('keeps an expired current-page decision findable by 已过期, while refusing every write', async () => {
  await mount('expired');
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="approval-filter-stale"]')?.click());
  // The accepted card removes duplicated/composite titles. Preserve the exact
  // known work itself, rather than demanding its old raw-address summary.
  expect(container.textContent).toContain(proposal.detail.content);
  expect(container.querySelector('[data-testid="approval-empty-state"]')).toBeNull();
  expect(container.querySelector('[data-testid="approval-empty-filtered"]')).toBeNull();
  expect(container.querySelector('[data-testid="approval-batch-bar"]')).toBeNull();
  expect(mocked.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
});
it.each([
  'mismatch',
  'missing',
  'unavailable',
  're-reading',
] as const)('does not present a known %s decision as an empty list', async (kind) => {
  await mount(kind);
  expect(container.textContent).toContain(proposal.detail.content);
  expect(container.querySelector('[data-testid="approval-empty-state"]')).toBeNull();
  expect(container.querySelector('[data-testid="approval-batch-bar"]')).toBeNull();
  for (const button of container.querySelectorAll<HTMLButtonElement>(
    '[data-testid="approve-btn"], [data-testid="reject-btn"]',
  )) {
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
  }
  expect(mocked.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
});
