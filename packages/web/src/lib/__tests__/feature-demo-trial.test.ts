import { beforeEach, expect, it, vi } from 'vitest';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import { useChatStore } from '@/stores/chatStore';
import { useConciergeStore } from '@/stores/conciergeStore';
import { apiFetch } from '@/utils/api-client';
import { openFeatureDemoTrial } from '../feature-demo-trial';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({ pushThreadRouteWithHistory: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({ currentThreadId: 'source-thread', pendingChatInsert: null });
  useConciergeStore.setState({ threadIdLoading: false, threadId: null, threadIdLoaded: false });
});
it('persists an appended owner draft with its content and revision before navigation, never sending a message', async () => {
  const calls: { path: string; method?: string; body?: Record<string, unknown> }[] = [];
  const image = { type: 'image', url: '/uploads/existing.png' };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    calls.push({ path, method: init?.method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path === '/api/concierge/thread') return Response.json({ threadId: 'companion' });
    if (init?.method === 'PUT') return Response.json({ revision: 13 });
    return Response.json({ revision: 12, draft: { text: '原来的草稿', contentBlocks: [image] } });
  });
  expect(await openFeatureDemoTrial('请提议创建新对话')).toBe(true);
  const write = calls.find((call) => call.method === 'PUT');
  expect(write?.body).toEqual({ expectedRevision: 12, text: '原来的草稿\n\n请提议创建新对话', contentBlocks: [image] });
  expect(pushThreadRouteWithHistory).toHaveBeenCalledWith('companion', window);
  expect(calls.some((call) => call.path.includes('/messages'))).toBe(false);
});
it('keeps the player recoverable and refuses navigation after a stale draft revision', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/concierge/thread') return Response.json({ threadId: 'companion' });
    if (init?.method === 'PUT') return Response.json({ error: 'conflict' }, { status: 409 });
    return Response.json({ revision: 14, draft: { text: '另一页正在编辑的草稿' } });
  });
  expect(await openFeatureDemoTrial('请提议创建新对话')).toBe(false);
  expect(pushThreadRouteWithHistory).not.toHaveBeenCalled();
});

it('projects the saved owner revision into an already-mounted companion composer', async () => {
  const { registerComposerDraftFlusher } = await import('@/components/composer-draft-flush-registry');
  useChatStore.setState({ currentThreadId: 'companion' });
  const release = registerComposerDraftFlusher('companion', async () => ({
    persisted: true,
    revision: 12,
    snapshot: { text: '原来的草稿', contextAttachments: [] },
  }));
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/concierge/thread') return Response.json({ threadId: 'companion' });
    if (init?.method === 'PUT') return Response.json({ revision: 13 });
    return Response.json({ revision: 12, draft: { text: '原来的草稿' } });
  });
  try {
    expect(await openFeatureDemoTrial('试用请求')).toBe(true);
    expect(useChatStore.getState().pendingChatInsert).toMatchObject({
      threadId: 'companion',
      text: '原来的草稿\n\n试用请求',
      authoritative: true,
      serverRevision: 13,
      clientSnapshot: { text: '原来的草稿', serverRevision: 12 },
    });
  } finally {
    release();
  }
});

it('does not start draft writes or navigation for a cancelled player action', async () => {
  const controller = new AbortController();
  controller.abort();
  expect(await openFeatureDemoTrial('试用请求', controller.signal)).toBe(false);
  expect(apiFetch).not.toHaveBeenCalled();
  expect(pushThreadRouteWithHistory).not.toHaveBeenCalled();
});
