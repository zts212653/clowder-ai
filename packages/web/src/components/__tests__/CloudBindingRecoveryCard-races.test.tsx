import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { CloudBindingRecoveryCard } from '@/components/CloudBindingRecoveryCard';
import { apiFetch } from '@/utils/api-client';

const mockApiFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function pluginState(conversationId: string): Record<string, unknown> {
  return {
    pluginId: 'personal-chrome-host',
    authorization: {
      status: 'authorized',
      conversations: [
        {
          conversationId,
          authorizedAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      ],
    },
  };
}

function RecoveryIdentityHarness({
  threadId,
  sourceMessageId,
  onIdentityCommit,
}: {
  threadId: string;
  sourceMessageId: string;
  onIdentityCommit: (threadId: string) => void;
}) {
  useLayoutEffect(() => onIdentityCommit(threadId), [onIdentityCommit, threadId]);
  return <CloudBindingRecoveryCard threadId={threadId} sourceMessageId={sourceMessageId} targetCatId="gpt-pro" />;
}

describe('CloudBindingRecoveryCard lifecycle fences', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderCard(threadId = 'thread-one', sourceMessageId = 'source-one') {
    await act(async () => {
      root.render(
        <CloudBindingRecoveryCard
          threadId={threadId}
          sourceMessageId={sourceMessageId}
          targetCatId="gpt-pro"
          attemptId={`attempt-${sourceMessageId}`}
        />,
      );
      await Promise.resolve();
    });
  }

  it('does not let an old thread fetch overwrite a newly rendered recovery card', async () => {
    let resolveOldPlugin!: (response: Response) => void;
    const oldPlugin = new Promise<Response>((resolve) => {
      resolveOldPlugin = resolve;
    });
    mockApiFetch.mockImplementation((path) => {
      if (path === '/api/plugins/personal-chrome' && mockApiFetch.mock.calls.length <= 2) return oldPlugin;
      if (path === '/api/plugins/personal-chrome')
        return Promise.resolve(jsonResponse(pluginState('conversation-new')));
      return Promise.resolve(jsonResponse({ bindings: {} }));
    });

    await renderCard();
    await renderCard('thread-new', 'source-new');
    expect(container.querySelector('code[title="conversation-new"]')).not.toBeNull();

    await act(async () => resolveOldPlugin(jsonResponse(pluginState('conversation-old'))));
    expect(container.querySelector('code[title="conversation-new"]')).not.toBeNull();
    expect(container.querySelector('code[title="conversation-old"]')).toBeNull();
  });

  it('does not submit hydrated state from the previous identity during the next identity commit', async () => {
    const pendingRead = new Promise<Response>(() => undefined);
    let pluginReads = 0;
    const responses = new Map<string, Promise<Response>>([
      ['GET /api/threads/thread-one/cloud-bindings', Promise.resolve(jsonResponse({ bindings: {} }))],
      [
        'GET /api/messages/source-one/queue-targets/gpt-pro/retry-authority',
        Promise.resolve(jsonResponse({ attemptId: 'attempt-old' })),
      ],
      ['GET /api/threads/thread-two/cloud-bindings', pendingRead],
      ['GET /api/messages/source-two/queue-targets/gpt-pro/retry-authority', pendingRead],
      [
        'PATCH /api/threads/thread-two/cloud-bindings',
        Promise.resolve(jsonResponse({ bindings: { 'gpt-pro': 'https://chatgpt.com/c/conversation-old' } })),
      ],
      [
        'POST /api/messages/source-two/queue-targets/gpt-pro/retry',
        Promise.resolve(jsonResponse({ status: 'retry_queued' }, 202)),
      ],
    ]);
    mockApiFetch.mockImplementation((path, init) => {
      if (path === '/api/plugins/personal-chrome') {
        pluginReads += 1;
        return pluginReads === 1 ? Promise.resolve(jsonResponse(pluginState('conversation-old'))) : pendingRead;
      }
      const response = responses.get(`${init?.method ?? 'GET'} ${path}`);
      if (response) return response;
      throw new Error(`unexpected ${String(path)} ${String(init?.method)}`);
    });

    const onIdentityCommit = vi.fn();
    await act(async () => {
      root.render(
        <RecoveryIdentityHarness
          threadId="thread-one"
          sourceMessageId="source-one"
          onIdentityCommit={onIdentityCommit}
        />,
      );
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(container.querySelector<HTMLButtonElement>('button[data-recovery-primary]')?.disabled).toBe(false);
    });
    const oldPrimary = container.querySelector<HTMLButtonElement>('button[data-recovery-primary]');
    expect(oldPrimary).not.toBeNull();

    onIdentityCommit.mockImplementation((committedThreadId) => {
      if (committedThreadId === 'thread-two') oldPrimary?.click();
    });
    await act(async () => {
      root.render(
        <RecoveryIdentityHarness
          threadId="thread-two"
          sourceMessageId="source-two"
          onIdentityCommit={onIdentityCommit}
        />,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain('正在查找已授权的 ChatGPT 会话');
    expect(container.querySelector('button[data-recovery-primary]')).toBeNull();
    expect(
      mockApiFetch.mock.calls.filter(
        ([path, init]) => path === '/api/threads/thread-two/cloud-bindings' && init?.method === 'PATCH',
      ),
    ).toHaveLength(0);
    expect(
      mockApiFetch.mock.calls.filter(
        ([path, init]) => path === '/api/messages/source-two/queue-targets/gpt-pro/retry' && init?.method === 'POST',
      ),
    ).toHaveLength(0);
  });

  it('fences duplicate clicks while the route write is pending', async () => {
    let resolvePatch!: (response: Response) => void;
    const pendingPatch = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    mockApiFetch.mockImplementation(async (path, init) => {
      if (path === '/api/plugins/personal-chrome') return jsonResponse(pluginState('one'));
      if (path.includes('/cloud-bindings') && !init?.method) return jsonResponse({ bindings: {} });
      if (path.includes('/cloud-bindings') && init?.method === 'PATCH') return pendingPatch;
      return jsonResponse({ status: 'retry_queued' }, 202);
    });

    await renderCard();
    const primary = container.querySelector<HTMLButtonElement>('button[data-recovery-primary]');
    act(() => {
      primary?.click();
      primary?.click();
    });
    expect(mockApiFetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
    await act(async () => resolvePatch(jsonResponse({ bindings: { 'gpt-pro': 'https://chatgpt.com/c/one' } })));
  });

  it('does not let an old route completion retry or update a newly rendered source', async () => {
    let resolveOldPatch!: (response: Response) => void;
    let pluginReads = 0;
    const oldPatch = new Promise<Response>((resolve) => {
      resolveOldPatch = resolve;
    });
    mockApiFetch.mockImplementation(async (path, init) => {
      if (path === '/api/plugins/personal-chrome') {
        pluginReads += 1;
        return jsonResponse(pluginState(pluginReads === 1 ? 'conversation-old' : 'conversation-new'));
      }
      if (path === '/api/threads/thread-one/cloud-bindings' && init?.method === 'PATCH') return oldPatch;
      if (String(path).includes('/retry')) return jsonResponse({ status: 'retry_queued' }, 202);
      return jsonResponse({ bindings: {} });
    });

    await renderCard();
    act(() => container.querySelector<HTMLButtonElement>('button[data-recovery-primary]')?.click());
    await renderCard('thread-new', 'source-new');
    await act(async () =>
      resolveOldPatch(jsonResponse({ bindings: { 'gpt-pro': 'https://chatgpt.com/c/conversation-old' } })),
    );

    expect(container.querySelector('code[title="conversation-new"]')).not.toBeNull();
    expect(container.textContent).not.toContain('已绑定，正在发送');
    expect(
      mockApiFetch.mock.calls.some(([path]) => path === '/api/messages/source-one/queue-targets/gpt-pro/retry'),
    ).toBe(false);
  });

  it('reports a stale retry fence without creating a replacement message', async () => {
    mockApiFetch.mockImplementation(async (path) => {
      if (path === '/api/plugins/personal-chrome') return jsonResponse(pluginState('conversation-bound'));
      if (path === '/api/threads/thread-one/cloud-bindings') {
        return jsonResponse({ bindings: { 'gpt-pro': 'https://chatgpt.com/c/conversation-bound' } });
      }
      return jsonResponse({ code: 'QUEUE_RETRY_AUTHORITY_STALE' }, 409);
    });

    await renderCard();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-recovery-primary]')?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('发送状态已经变化');
    expect(mockApiFetch.mock.calls.some(([path]) => path === '/api/messages')).toBe(false);
  });
});
