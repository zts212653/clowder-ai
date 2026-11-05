import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import { createApprovalSessions } from '../approval-sessions';
import { HostedApprovalCard } from '../HostedApprovalCard';
import { resolveOriginalPlace } from '../original-place';
import { approvalRow, OWNER, okRead, storeItem } from './mailbox-fixtures';

const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: network.fetch }));
vi.mock('@/stores/chatStore', () => {
  const useChatStore = (select: (s: Record<string, unknown>) => unknown) => select({ threads: [] });
  useChatStore.getState = () => ({ currentThreadId: null, threads: [] });
  return { useChatStore };
});
vi.mock('@/utils/scrollToMessage', () => ({ scrollToMessage: vi.fn() }));
vi.mock('@/utils/teleport', () => ({ planTeleport: () => ({}), kickTeleportResolve: vi.fn() }));
vi.mock('../../../ThreadSidebar/thread-navigation', () => ({ pushThreadRouteWithHistory: vi.fn() }));

beforeEach(() => {
  observeApiSessionOwner('owner-1');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
const mounted: Array<() => void> = [];
afterEach(() => {
  for (const dispose of mounted.splice(0)) dispose();
  network.fetch.mockReset();
});

async function mountOriginalProposal(extra: Record<string, unknown> = {}) {
  const detail = Object.fromEntries(
    Object.entries({
      title: '调查这件事',
      reason: '先查清原始证据，再做决定。\n请保留这段原话。',
      preferredCats: ['codex61-sol'],
      parentThreadId: 'source',
      projectPath: '/isolated/project',
      initialMessage: '请调查',
      reportingMode: 'final-only',
      ...extra,
    }).filter(([, value]) => value !== undefined),
  );
  const item = storeItem({ inlineApprovable: false, detail, summary: 'New thread: 调查这件事' });
  const read = okRead([approvalRow(item)]);
  let generation = 1;
  const sessions = createApprovalSessions({
    readsStarted: () => generation,
    refetch: () => {
      generation++;
    },
    refreshStore: async () => {},
    storeItems: () => [item],
    attempts: () => ({}),
    latestRead: () => ({ result: read, generation }),
    now: () => Date.now(),
  });
  useApprovalHubStore.setState({
    items: [item],
    deciding: {},
    decisionAttempts: {},
    count: 1,
    pendingReadAvailable: true,
    isLoading: false,
    pendingOwnerUserId: OWNER,
  });
  network.fetch.mockImplementation(async (path: string) => {
    if (path === '/api/approval-hub/pending')
      return Response.json({
        items: [item],
        count: 1,
        pendingReadAvailable: true,
        isLoading: false,
        pendingOwnerUserId: OWNER,
      });
    if (path === `/api/threads/${detail.parentThreadId}`)
      return Response.json({
        id: detail.parentThreadId,
        title: '已核实的父对话',
        projectPath: detail.projectPath,
        createdBy: OWNER,
      });
    if (path === '/api/proposals/p-1')
      return Response.json({
        proposal: {
          ...detail,
          proposalId: 'p-1',
          createdBy: OWNER,
          createdAt: item.createdAt,
          sourceCatId: 'opus',
          status: 'pending',
          sourceThreadId: 'thread-src',
          ...extra,
        },
      });
    throw new Error(`unexpected ${path}`);
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <HostedApprovalCard
        item={approvalRow(item)}
        ownerUserId={OWNER}
        sessions={sessions}
        place={resolveOriginalPlace(approvalRow(item))}
        onOpen={() => {}}
      />,
    ),
  );
  await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  return { container, detail };
}

it('hosts the original F128 reason, executor and create action without offering a list detour', async () => {
  const { container, detail } = await mountOriginalProposal();
  expect(container.textContent).toContain(detail.reason);
  expect(container.textContent).toContain('谁来做');
  expect(container.querySelector('[data-testid="proposal-actions"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="approve-btn"]')?.textContent).toBe('同意并创建');
  expect(container.textContent).not.toContain('打开审批列表');
  expect(container.textContent).not.toContain('原处暂不可定位');
});

const fullScope = {
  featureRef: 'feature:F322',
  phaseKey: 'S3',
  workUnitRef: 'feature-phase:F322:S3',
  acceptedSourceRef: 'file:docs/features/F322-everyday-work-experience.md',
  acceptedRevision: 'a'.repeat(40),
};
it('shows the actual parent and complete source of the development authority being granted', async () => {
  const { container } = await mountOriginalProposal({
    parentThreadId: 'parent-contract',
    approvedDevelopmentScope: fullScope,
    subjectTaskId: 'task:work:exact-approval-work',
    subjectTaskTitle: '审批实施',
  });
  expect(container.textContent).toContain('已核实的父对话');
  expect(container.textContent).not.toContain('parent-contract');
  const technical = [...container.querySelectorAll('details')].find(
    (node) => node.querySelector('summary')?.textContent === '技术详情',
  );
  expect(technical?.open).toBe(false);
  await act(async () => technical?.querySelector('summary')?.click());
  expect(technical?.open).toBe(true);
  expect(technical?.textContent).toContain('审批实施');
  expect(technical?.textContent).toContain('task:work:exact-approval-work');
  expect(container.textContent).toContain(fullScope.acceptedSourceRef);
  expect(container.textContent).toContain(fullScope.featureRef);
  expect(container.textContent).toContain(fullScope.phaseKey);
  expect(container.textContent).toContain(fullScope.acceptedRevision);
});
it.each([
  'parallel',
  'standalone',
])('shows the original resolver default for %s with no explicit reporting mode', async (declaredWorkMode) => {
  const { container } = await mountOriginalProposal({ declaredWorkMode, reportingMode: undefined });
  expect(container.textContent).toContain(' · 不回报');
  expect(container.textContent).not.toContain('autonomous');
});
it('cannot submit a partially readable development scope without its exact accepted source', async () => {
  const { featureRef, phaseKey, workUnitRef, acceptedRevision } = fullScope;
  const incomplete = { featureRef, phaseKey, workUnitRef, acceptedRevision };
  const { container } = await mountOriginalProposal({ approvedDevelopmentScope: incomplete });
  const approve = container.querySelector<HTMLButtonElement>('[data-testid="approve-btn"]');
  expect(approve).toBeNull();
  await act(async () => approve?.click());
  expect(network.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
});
