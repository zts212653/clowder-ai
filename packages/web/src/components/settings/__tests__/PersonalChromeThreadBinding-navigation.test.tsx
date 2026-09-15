import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ search: new URLSearchParams() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => navigation.search }));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { CloudConversationLink } from '@/components/CloudConversationLink';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { PersonalChromePluginPanel } from '../PersonalChromePluginPanel';
import { PersonalChromeThreadBinding } from '../PersonalChromeThreadBinding';

const mockApiFetch = vi.mocked(apiFetch);
const conversations = ['conversation-a', 'conversation-b'].map((conversationId) => ({
  conversationId,
  authorizedAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
}));
const binding = (conversationId: string) => ({ bindings: { 'gpt-pro': `https://chatgpt.com/c/${conversationId}` } });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const route = (threadId: string) => `/api/threads/${encodeURIComponent(threadId)}/cloud-bindings`;

function pluginState() {
  return {
    pluginId: 'personal-chrome-host',
    channel: 'developer_preview',
    platform: 'darwin',
    platformSupport: 'supported',
    artifact: { helper: 'ready', extension: 'chrome_web_store' },
    distribution: { channel: 'chrome_web_store', integration: 'ready', publication: 'unavailable' },
    config: { status: 'ready' },
    authorization: { status: 'authorized', count: 2, limit: 32, conversations },
    intent: { status: 'developer_preview' },
    live: { status: 'stale_adapter' },
  };
}

describe('cloud binding settings navigation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    navigation.search = new URLSearchParams();
    window.history.replaceState(null, '', '/');
    mockApiFetch.mockReset();
    useChatStore.setState({ currentThreadId: 'default', threads: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.history.replaceState(null, '', '/');
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const renderBinding = async () => {
    await act(async () => root.render(<PersonalChromeThreadBinding conversations={conversations} disabled={false} />));
  };
  const selectReplacement = async () => {
    const button = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('用于当前 thread'),
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
  };

  it('carries the source through a full settings load and changes only its binding, even with a stale adapter', async () => {
    const source = 'thread-owner-journey';
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugins/personal-chrome') return response(pluginState());
      if (url === route(source))
        return response(binding(init?.method === 'PATCH' ? 'conversation-b' : 'conversation-a'));
      return response({ error: 'Forbidden' }, 403);
    });
    await act(async () => root.render(<CloudConversationLink threadId={source} />));
    const link = [...container.querySelectorAll('a')].find((candidate) => candidate.textContent === '更换绑定');
    expect(link).toBeDefined();
    const destination = new URL(link?.href ?? '', window.location.origin);
    expect(destination.searchParams.get('threadId')).toBe(source);

    // Simulate the plain anchor's new document: memory starts at default, URL survives.
    act(() => root.unmount());
    root = createRoot(container);
    useChatStore.setState({ currentThreadId: 'default', threads: [] });
    navigation.search = destination.searchParams;
    window.history.replaceState(null, '', destination.pathname + destination.search + destination.hash);
    await act(async () => root.render(<PersonalChromePluginPanel />));
    expect(container.textContent).toContain(source);
    expect(container.textContent).not.toContain('当前是系统 thread');
    expect(container.textContent).toContain('扩展待重载');
    expect(mockApiFetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
    await selectReplacement();
    const writes = mockApiFetch.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(writes).toEqual([
      [
        route(source),
        expect.objectContaining({
          body: JSON.stringify({ catId: 'gpt-pro', chatUrl: 'https://chatgpt.com/c/conversation-b' }),
        }),
      ],
    ]);
    expect(mockApiFetch.mock.calls.some(([url]) => url === route('default'))).toBe(false);
    expect(useChatStore.getState().currentThreadId).toBe('default');
    expect(container.textContent).toContain('当前 thread 已路由到 conversation-b');
  });

  it('honors the URL over a different active chat without switching that chat', async () => {
    useChatStore.setState({ currentThreadId: 'thread-other' });
    navigation.search = new URLSearchParams({ threadId: 'thread-source' });
    mockApiFetch.mockResolvedValue(response(binding('conversation-a')));
    await renderBinding();
    expect(mockApiFetch).toHaveBeenCalledWith(route('thread-source'), expect.any(Object));
    expect(mockApiFetch.mock.calls.some(([url]) => url === route('thread-other'))).toBe(false);
    expect(useChatStore.getState().currentThreadId).toBe('thread-other');
  });

  it('uses the active chat for settings opened without an explicit source', async () => {
    useChatStore.setState({ currentThreadId: 'thread-active' });
    mockApiFetch.mockResolvedValue(response(binding('conversation-a')));
    await renderBinding();
    expect(mockApiFetch).toHaveBeenCalledWith(route('thread-active'), expect.any(Object));
  });

  it('does not turn a denied explicit source into the active or default thread', async () => {
    navigation.search = new URLSearchParams({ threadId: 'thread-foreign' });
    mockApiFetch.mockResolvedValue(response({ error: 'Forbidden' }, 403));
    await renderBinding();
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(mockApiFetch).toHaveBeenCalledWith(route('thread-foreign'), expect.any(Object));
    expect(container.textContent).not.toContain('当前是系统 thread');
    expect(container.textContent).toContain('无权');
    expect(container.querySelector('button')).toBeNull();
  });

  it('keeps empty explicit sources invalid instead of silently using another chat', async () => {
    useChatStore.setState({ currentThreadId: 'thread-active' });
    navigation.search = new URLSearchParams('threadId=');
    await renderBinding();
    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(container.querySelector('button')).toBeNull();
  });

  it('rejects ambiguous targets and keeps system-thread denial intact', async () => {
    navigation.search = new URLSearchParams('threadId=thread-a&threadId=thread-b');
    await renderBinding();
    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(container.textContent).toContain('未指定有效的 thread');
    navigation.search = new URLSearchParams({ threadId: 'default' });
    mockApiFetch.mockResolvedValue(response({ error: 'System-owned thread' }, 403));
    await renderBinding();
    expect(container.textContent).toContain('当前是系统 thread');
    expect(container.querySelector('button')).toBeNull();
  });

  it('ignores a prior target read that finishes after settings switches target', async () => {
    let resolveOld!: (body: unknown) => void;
    const oldBody = new Promise((resolve) => {
      resolveOld = resolve;
    });
    mockApiFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => oldBody } as Response)
      .mockResolvedValueOnce(response(binding('conversation-b')));
    navigation.search = new URLSearchParams({ threadId: 'thread-a' });
    await renderBinding();
    navigation.search = new URLSearchParams({ threadId: 'thread-b' });
    await renderBinding();
    expect(container.textContent).toContain('当前 thread 已路由到 conversation-b');
    await act(async () => resolveOld(binding('conversation-a')));
    expect(container.textContent).toContain('当前 thread 已路由到 conversation-b');
    expect(container.textContent).not.toContain('当前 thread 已路由到 conversation-a');
  });

  it('keeps a pending save attached to the old target without publishing it on the new target', async () => {
    let resolveSave!: (response: Response) => void;
    const save = new Promise<Response>((resolve) => {
      resolveSave = resolve;
    });
    mockApiFetch.mockImplementation(async (url, init) => {
      if (init?.method === 'PATCH') return save;
      return response(binding(url === route('thread-a') ? 'conversation-a' : 'conversation-b'));
    });
    navigation.search = new URLSearchParams({ threadId: 'thread-a' });
    await renderBinding();
    await selectReplacement();
    navigation.search = new URLSearchParams({ threadId: 'thread-b' });
    await renderBinding();
    await act(async () => resolveSave(response(binding('saved-for-a'))));
    expect(container.textContent).toContain('当前 thread 已路由到 conversation-b');
    expect(container.textContent).not.toContain('saved-for-a');
    expect(mockApiFetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')[0]?.[0]).toBe(route('thread-a'));
  });
});
