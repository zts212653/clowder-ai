import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAttentionClusters } from '@/components/ThreadSidebar/use-attention-clusters';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import { ProposalCard } from '../ProposalCard';

const { fetchMock, refreshMock, chatState } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  refreshMock: vi.fn(async () => true),
  chatState: { threads: [], updateThreadPin: vi.fn() },
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => fetchMock(...args) }));
vi.mock('@/utils/sidebar-thread-snapshot', () => ({ invalidateSidebarProjection: refreshMock }));
vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({ pushThreadRouteWithHistory: vi.fn() }));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => React.createElement('p', null, content),
}));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector?: (s: typeof chatState) => unknown) => (selector ? selector(chatState) : chatState),
    { getState: () => chatState },
  ),
}));

const id = 'proposal_group_test';
const before = { aliases: {}, open: {}, groups: [{ id: 'attention_a', threadIds: ['a', 'b'] }] };
const after = { ...before, groups: [{ id: 'attention_a', threadIds: ['a', 'b', 'new-thread'] }] };
let current: ReturnType<typeof useAttentionClusters>;
let accepted: boolean;
let rejectApproval: boolean;
let lostResponse: 'network' | 'body' | 'before-commit' | null;
let root: Root;
let container: HTMLDivElement;
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
        actions: [{ label: '批准并创建', action: 'propose:approve', payload: { proposalId: id } }],
      }}
    />
  );
}
beforeEach(() => {
  observeApiSessionOwner(null);
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.localStorage.setItem('cat-cafe:shell-presentation', 'classic');
  accepted = false;
  rejectApproval = false;
  lostResponse = null;
  refreshMock.mockClear();
  fetchMock.mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/config/thread-attention') return Response.json(accepted ? after : before);
    if (path === `/api/proposals/${id}/approve`) {
      if (rejectApproval) return Response.json({ error: 'Forbidden' }, { status: 403 });
      accepted = lostResponse !== 'before-commit';
      if (lostResponse === 'network' || lostResponse === 'before-commit') throw new TypeError('Response lost');
      if (lostResponse === 'body')
        return Object.assign(Response.json({}), { json: () => Promise.reject(new TypeError('Body lost')) });
      return Response.json({ proposalId: id, threadId: 'new-thread', status: 'approved' });
    }
    return new Response('{}', { status: 404 });
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  observeApiSessionOwner(null);
});
async function approve() {
  await act(async () => root.render(<App />));
  expect(current.savedGroups).toEqual(before.groups);
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('批准并创建'));
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

it('refreshes the mounted Group after HTTP approval with no Socket notification', async () => {
  await approve();
  expect(accepted).toBe(true);
  expect(container.textContent).toContain('已批准');
  expect(current.savedGroups).toEqual(after.groups);
  expect(refreshMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls.filter(([path]) => path === '/api/config/thread-attention/groups')).toHaveLength(0);
});
it('does not report an approval or invalidate membership after HTTP refusal', async () => {
  rejectApproval = true;
  await approve();
  expect(accepted).toBe(false);
  expect(refreshMock).not.toHaveBeenCalled();
  expect(current.savedGroups).toEqual(before.groups);
  expect(fetchMock.mock.calls.filter(([path]) => path === '/api/config/thread-attention')).toHaveLength(1);
});

it.each([
  'network',
  'body',
  'before-commit',
] as const)('reads back an unknown %s result without repeating approval or inventing success', async (loss) => {
  lostResponse = loss;
  await approve();
  expect(current.savedGroups).toEqual(loss === 'before-commit' ? before.groups : after.groups);
  expect(refreshMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls.filter(([path]) => path === `/api/proposals/${id}/approve`)).toHaveLength(1);
  expect(container.textContent).toContain('尚未确认');
  expect(container.textContent).not.toContain('已批准');
  if (loss === 'before-commit') {
    accepted = true;
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(current.savedGroups).toEqual(after.groups);
  }
});

it.each([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
])('retains approval arriving %i microtasks after an older Group response', async (delay) => {
  let finishGroup!: (response: Response) => void;
  let finishApproval!: () => void;
  let reads = 0;
  fetchMock.mockImplementation(async (path: string) => {
    if (path === '/api/config/thread-attention') {
      if (++reads === 2)
        return new Promise<Response>((resolve) => {
          finishGroup = resolve;
        });
      return Response.json(accepted ? after : before);
    }
    if (path === `/api/proposals/${id}/approve`)
      return new Promise<Response>((resolve) => {
        finishApproval = () => {
          accepted = true;
          resolve(Object.assign(Response.json({}), { json: () => Promise.resolve({ threadId: 'new-thread' }) }));
        };
      });
    return new Response('{}', { status: 404 });
  });
  await act(async () => root.render(<App />));
  await act(async () => window.dispatchEvent(new Event('cat-cafe:socket-reconnected')));
  await approve();
  await act(async () => {
    finishGroup(Object.assign(Response.json({}), { json: () => Promise.resolve(before) }));
    let remaining = delay;
    const settleApproval = () => {
      if (remaining-- > 0) queueMicrotask(settleApproval);
      else finishApproval();
    };
    queueMicrotask(settleApproval);
  });
  expect(current.savedGroups).toEqual(after.groups);
  expect(container.textContent).toContain('已批准');
});

it.each([
  'approved',
  'pending',
  'approving',
])('uses canonical %s readback to describe an unknown approval honestly', async (result) => {
  observeApiSessionOwner('group-approval-owner');
  lostResponse = 'network';
  const original = fetchMock.getMockImplementation();
  if (!original) throw new Error('Missing API fixture');
  fetchMock.mockImplementation((path: string, ...args: unknown[]) => {
    if (path === `/api/proposals/${id}`)
      return Promise.resolve(
        Response.json({
          proposal: {
            proposalId: id,
            status: accepted ? result : 'pending',
            ...(accepted && result === 'approved' ? { createdThreadId: 'new-thread' } : {}),
          },
        }),
      );
    return original(path, ...args);
  });
  await approve();
  expect(current.savedGroups).toEqual(after.groups);
  expect(fetchMock.mock.calls.filter(([path]) => path === `/api/proposals/${id}/approve`)).toHaveLength(1);
  if (result === 'approved') {
    expect(container.textContent).toContain('已批准');
    expect(container.textContent).not.toContain('尚未确认');
  } else {
    expect(container.textContent).not.toContain('已批准');
    expect(container.textContent).toContain('尚未确认');
  }
});
