import type { ThreadProposal, UnifiedAttentionReadV1 } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import { MailboxButton } from '../MailboxButton';
import { approvalRow, OWNER, okRead, storeItem } from '../mailbox/__tests__/mailbox-fixtures';
import { SHELL_PRESENTATION_STORAGE_KEY, writeShellPresentation } from '../shell-presentation';

const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: network.fetch }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/thread/source',
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/hooks/useCatNameResolver', () => ({ useCatNameResolver: () => () => '小太阳' }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: () => ({
      displayName: '小太阳',
      nickname: '砚砚',
      defaultModel: 'gpt-6.1-sol',
      avatar: '',
      color: { primary: 'var(--shell-ink)', secondary: 'var(--shell-paper)' },
    }),
  }),
}));
vi.mock('@/stores/chatStore', () => {
  const state = { threads: [], currentThreadId: null, setWorkspaceMode: vi.fn() };
  const useChatStore = (select: (value: typeof state) => unknown) => select(state);
  useChatStore.getState = () => state;
  return { useChatStore };
});

const proposal: ThreadProposal = {
  proposalId: 'p-1',
  status: 'pending',
  sourceThreadId: 'source',
  sourceInvocationId: 'invocation',
  sourceCatId: 'opus' as ThreadProposal['sourceCatId'],
  title: '保留正在操作的提议',
  reason: '检查原卡片。',
  parentThreadId: 'source',
  preferredCats: ['opus' as ThreadProposal['sourceCatId']],
  initialMessage: '从这里开始',
  projectPath: '/isolated',
  reportingMode: 'final-only',
  createdBy: OWNER,
  createdAt: 500_000,
};
const item = storeItem({
  inlineApprovable: false,
  detail: {
    title: proposal.title,
    reason: proposal.reason,
    parentThreadId: proposal.parentThreadId,
    preferredCats: proposal.preferredCats,
    initialMessage: proposal.initialMessage,
    projectPath: proposal.projectPath,
    reportingMode: proposal.reportingMode,
  },
});
function read(): UnifiedAttentionReadV1 {
  const result = okRead([
    {
      ...approvalRow(item),
      preferenceCoordinate: { kind: 'mailbox', decisionRef: 'approval:p-1', version: 'sha256:server-version' },
    },
  ]);
  if (result.kind !== 'ok') throw new Error('Expected the complete owner fixture');
  const source = result.read.sources.approvals;
  return {
    ...result.read,
    attentionCount: 1,
    sources: {
      ...result.read.sources,
      structuredChoices: { ...source, coverage: 'pending_f306_structured_choices' },
      personalPreferences: { ...source, coverage: 'owner_personal_ignored_items' },
    },
    personalView: {
      mode: 'visible',
      preferenceRevision: 0,
      originalTotalCount: 1,
      visibleTotalCount: 1,
      ignoredTotalCount: 0,
      originalAttentionCount: 1,
      visibleAttentionCount: 1,
      ignoredAttentionCount: 0,
      groupCounts: {
        original: { decisions: 1, userMentions: 0, other: 0 },
        visible: { decisions: 1, userMentions: 0, other: 0 },
        ignored: { decisions: 0, userMentions: 0, other: 0 },
      },
    },
  };
}
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let pendingRead: ReturnType<typeof deferred> | null;
let pendingSession: ReturnType<typeof deferred> | null;
let root: Root;
let container: HTMLDivElement;
const row = () => document.querySelector<HTMLElement>('[data-testid="mailbox-item"]');
const pin = () => row()?.querySelector<HTMLInputElement>('input[role="switch"]');
async function invalidate() {
  await act(async () => window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated')));
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  observeApiSessionOwner(OWNER);
  writeShellPresentation('v2');
  pendingRead = null;
  pendingSession = null;
  network.fetch.mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/session') return pendingSession?.promise ?? Response.json({ userId: OWNER });
    if (path.startsWith('/api/concierge/work/decisions?')) return pendingRead?.promise ?? Response.json(read());
    if (path === '/api/proposals/p-1') return Response.json({ proposal });
    if (path === '/api/approval-hub/pending') return Response.json({ items: [item], count: 1 });
    if (path === '/api/threads/source')
      return Response.json({ id: 'source', title: '原对话', projectPath: '/isolated' });
    return Response.json({ ownerUserId: OWNER, revision: 0, entries: [], groups: [] });
  });
  useApprovalHubStore.setState({
    items: [item],
    count: 1,
    pendingReadAvailable: true,
    pendingOwnerUserId: OWNER,
    isLoading: false,
    deciding: {},
    decisionAttempts: {},
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<MailboxButton />));
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mailbox-button"]')?.click());
  expect(pin()).toBeDefined();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.removeItem(SHELL_PRESENTATION_STORAGE_KEY);
  vi.unstubAllGlobals();
});

it('keeps the actual proposal, its pin draft and group counts through every phase of a background refresh', async () => {
  const original = row();
  await act(async () => pin()?.click());
  expect(pin()?.checked).toBe(true);
  pendingRead = deferred();
  pendingSession = deferred();
  await invalidate();
  expect(row()).toBe(original);
  expect(pin()?.checked).toBe(true);
  expect(document.querySelector('[data-testid="mailbox-group-decisions"] h3')?.textContent).toBe('等你决定1');
  expect(document.querySelector('[data-testid="mailbox-state-text"]')?.textContent).toContain('1');
  const approve = row()?.querySelector<HTMLButtonElement>('[data-testid="approve-btn"]');
  expect(approve?.disabled).toBe(true);
  await act(async () => approve?.click());
  expect(network.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  await act(async () => pendingSession?.resolve(Response.json({ userId: OWNER })));
  expect(row()).toBe(original);
  expect(pin()?.checked).toBe(true);
  await act(async () => pendingRead?.resolve(Response.json(read())));
  expect(row()).toBe(original);
  expect(pin()?.checked).toBe(true);
  expect(row()?.querySelector<HTMLButtonElement>('[data-testid="approve-btn"]')?.disabled).toBe(false);
});

it('withdraws retained cards when the read actually fails', async () => {
  pendingRead = deferred();
  await invalidate();
  expect(row()).not.toBeNull();
  await act(async () => pendingRead?.resolve(new Response('{}', { status: 500 })));
  expect(row()).toBeNull();
});

it('keeps the approval filter panel mounted during its background refresh', async () => {
  await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="mailbox-tools"]')?.click());
  const filter = document.querySelector('[data-testid="approval-filter-thread"]');
  expect(filter).not.toBeNull();
  pendingRead = deferred();
  await invalidate();
  expect(document.querySelector('[data-testid="approval-filter-thread"]')).toBe(filter);
  await act(async () => pendingRead?.resolve(Response.json(read())));
  expect(document.querySelector('[data-testid="approval-filter-thread"]')).toBe(filter);
});

it('removes the old owner’s cards immediately when the observed session changes during refresh', async () => {
  pendingRead = deferred();
  pendingSession = deferred();
  await invalidate();
  await act(async () => observeApiSessionOwner('other-owner'));
  expect(row()).toBeNull();
  await act(async () => pendingSession?.resolve(Response.json({ userId: 'other-owner' })));
  await act(async () => pendingRead?.resolve(Response.json(read())));
  expect(row()).toBeNull();
});
