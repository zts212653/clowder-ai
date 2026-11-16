import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { fetchMock, navigateMock, chatState } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  navigateMock: vi.fn(),
  chatState: { threads: [], updateThreadPin: vi.fn() },
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => fetchMock(...args) }));
vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({
  pushThreadRouteWithHistory: (...args: unknown[]) => navigateMock(...args),
}));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => React.createElement('p', null, content),
}));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector?: (s: typeof chatState) => unknown) => (selector ? selector(chatState) : chatState),
    { getState: () => chatState },
  ),
}));

import { ProposalCard } from '@/components/rich/ProposalCard';
import { useAttentionClusters } from '@/components/ThreadSidebar/use-attention-clusters';
import { observeApiSessionOwner } from '@/utils/api-session-identity';

const id = 'proposal_test123';
const before = { aliases: {}, open: {}, groups: [{ id: 'attention_a', threadIds: ['a', 'b'] }] };
const after = { ...before, groups: [{ id: 'attention_a', threadIds: ['a', 'b', 'new-thread'] }] };
let current: ReturnType<typeof useAttentionClusters>;
let accepted = false;
function App() {
  current = useAttentionClusters([], 'default', '');
  return (
    <ProposalCard
      block={{
        id: `proposal-${id}`,
        kind: 'card',
        v: 1,
        title: 'Thread proposal',
        bodyMarkdown: 'Please approve',
        tone: 'info',
        fields: [],
        actions: [
          { label: '批准并创建', action: 'propose:approve', payload: { proposalId: id } },
          { label: '驳回', action: 'propose:reject', payload: { proposalId: id } },
        ],
      }}
    />
  );
}
let serverTerminal: 'rejected' | 'withdrawn' | 'approving' | null = null;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  observeApiSessionOwner('approval-owner');
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.localStorage.setItem('cat-cafe:shell-presentation', 'classic');
  accepted = false;
  serverTerminal = null;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (path: string) => {
    if (path === '/api/config/thread-attention') return Response.json(accepted ? after : before);
    if (path === `/api/proposals/${id}`)
      return Response.json({
        proposal: {
          proposalId: id,
          status: accepted ? 'approved' : (serverTerminal ?? 'pending'),
          ...(accepted ? { createdThreadId: 'new-thread' } : {}),
        },
      });
    if (path === `/api/proposals/${id}/approve`) throw new TypeError('approval response lost');
    return new Response('{}', { status: 404 });
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  observeApiSessionOwner(null);
});
async function beginUnknown() {
  await act(async () => root.render(<App />));
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('批准并创建'));
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(container.textContent).toContain('尚未确认');
  return button!;
}
it('does not send a second approval while the result is still unconfirmed', async () => {
  const button = await beginUnknown();
  await act(async () => button.click());
  expect(fetchMock.mock.calls.filter(([path]) => path === `/api/proposals/${id}/approve`)).toHaveLength(1);
});
it('rechecks the proposal after a later commit when the page regains focus', async () => {
  await beginUnknown();
  const previousReads = fetchMock.mock.calls.filter(([path]) => path === `/api/proposals/${id}`).length;
  const previousSidebarReads = fetchMock.mock.calls.filter(([path]) => path === '/api/threads?view=sidebar').length;
  accepted = true;
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(current.savedGroups).toEqual(after.groups);
  expect(fetchMock.mock.calls.filter(([path]) => path === `/api/proposals/${id}`).length).toBeGreaterThan(
    previousReads,
  );
  expect(fetchMock.mock.calls.filter(([path]) => path === '/api/threads?view=sidebar').length).toBeGreaterThan(
    previousSidebarReads,
  );
  expect(container.textContent).toContain('已批准');
  expect(container.textContent).not.toContain('尚未确认');
});

it.each([
  ['rejected', '已驳回'],
  ['withdrawn', '已撤回'],
] as const)('clears the unconfirmed notice after canonical %s', async (terminal, label) => {
  await beginUnknown();
  serverTerminal = terminal;
  await act(async () =>
    window.dispatchEvent(new CustomEvent('cat-cafe:proposal-updated', { detail: { proposalId: id } })),
  );
  expect(container.textContent).toContain(label);
  expect(container.textContent).not.toContain('尚未确认');
});

it('allows an explicit retry only after a deliberate canonical pending check', async () => {
  const submit = await beginUnknown();
  const check = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === '重新核对状态');
  expect(check).toBeDefined();
  await act(async () => check!.click());
  expect(fetchMock.mock.calls.filter(([path]) => path === `/api/proposals/${id}/approve`)).toHaveLength(1);
  expect(container.textContent).toContain('可重新提交');
  expect(submit.disabled).toBe(false);
  await act(async () => submit.click());
  expect(fetchMock.mock.calls.filter(([path]) => path === `/api/proposals/${id}/approve`)).toHaveLength(2);
});
it('keeps approving blocked after an explicit check and can check again', async () => {
  const submit = await beginUnknown();
  serverTerminal = 'approving';
  const check = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === '重新核对状态');
  expect(check).toBeDefined();
  await act(async () => check!.click());
  expect(container.textContent).toContain('尚未确认');
  expect(submit.disabled).toBe(true);
  expect(fetchMock.mock.calls.filter(([path]) => path === `/api/proposals/${id}/approve`)).toHaveLength(1);
});

it('keeps a failed check recoverable without submitting again', async () => {
  const submit = await beginUnknown();
  fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 503 }));
  const check = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === '重新核对状态')!;
  await act(async () => check.click());
  expect(submit.disabled).toBe(true);
  expect(check.disabled).toBe(false);
  accepted = true;
  await act(async () => check.click());
  expect(container.textContent).toContain('已批准');
  expect(container.textContent).not.toContain('尚未确认');
  expect(fetchMock.mock.calls.filter(([path]) => path === `/api/proposals/${id}/approve`)).toHaveLength(1);
});
