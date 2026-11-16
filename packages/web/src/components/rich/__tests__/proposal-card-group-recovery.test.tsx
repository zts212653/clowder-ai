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
let serverTerminal: 'rejected' | 'withdrawn' | null = null;
let placed = false;
let groupId: string | null = 'attention_a';
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  observeApiSessionOwner('approval-owner');
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.localStorage.setItem('cat-cafe:shell-presentation', 'classic');
  accepted = false;
  placed = false;
  groupId = 'attention_a';
  serverTerminal = null;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (path: string) => {
    if (path === '/api/config/thread-attention') return Response.json(placed ? after : before);
    if (path === `/api/proposals/${id}`)
      return Response.json({
        proposal: {
          proposalId: id,
          status: accepted ? 'approved' : (serverTerminal ?? 'pending'),
          ...(accepted ? { createdThreadId: 'new-thread', attentionGroupId: groupId } : {}),
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

function placementCheck() {
  return [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === '重新核对分组');
}
it('retains a read-only Group action when approval is finalized before placement', async () => {
  await beginUnknown();
  accepted = true;
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(container.textContent).toContain('已批准');
  expect(container.textContent).not.toContain('尚未确认');
  expect(current.savedGroups).toEqual(before.groups);
  expect(placementCheck()).toBeDefined();
  placed = true;
  await act(async () => placementCheck()!.click());
  expect(current.savedGroups).toEqual(after.groups);
  expect(fetchMock.mock.calls.filter(([path]) => path.endsWith('/approve'))).toHaveLength(1);
});
it('keeps a failed placement recoverable without locking the approved thread or rewriting membership', async () => {
  await beginUnknown();
  accepted = true;
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(placementCheck()).toBeDefined();
  await act(async () => placementCheck()!.click());
  expect(current.savedGroups).toEqual(before.groups);
  expect(container.textContent).toContain('已批准');
  expect(container.textContent).not.toContain('尚未确认');
  const open = container.querySelector<HTMLButtonElement>('[data-testid="thread-link"]');
  expect(open?.disabled).toBe(false);
  await act(async () => open!.click());
  expect(navigateMock).toHaveBeenCalledWith('new-thread', window);
  expect(placementCheck()?.disabled).toBe(false);
  expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
});
it('finishes ordinary recovery when no Group was selected', async () => {
  await beginUnknown();
  groupId = null;
  accepted = true;
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(container.textContent).toContain('已批准');
  expect(container.textContent).not.toContain('尚未确认');
  expect(placementCheck()).toBeUndefined();
  expect(
    [...container.querySelectorAll('button')].some((button) => button.textContent?.trim() === '重新核对状态'),
  ).toBe(false);
});
it('also refreshes placement on a later foreground event without a second decision', async () => {
  await beginUnknown();
  accepted = true;
  await act(async () => window.dispatchEvent(new Event('focus')));
  const reads = fetchMock.mock.calls.filter(([path]) => path === '/api/proposals/' + id).length;
  placed = true;
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(current.savedGroups).toEqual(after.groups);
  expect(fetchMock.mock.calls.filter(([path]) => path === '/api/proposals/' + id).length).toBeGreaterThan(reads);
  expect(fetchMock.mock.calls.filter(([path]) => path.endsWith('/approve'))).toHaveLength(1);
});
