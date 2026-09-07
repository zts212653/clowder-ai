import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { CloudBindingRecoveryCard } from '@/components/CloudBindingRecoveryCard';
import { apiFetch } from '@/utils/api-client';

const mockApiFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function pluginState(
  conversations: Array<{
    conversationId: string;
    displayTitle?: string;
    authorizedAt?: string;
    updatedAt?: string;
  }> = [],
): Record<string, unknown> {
  return {
    pluginId: 'personal-chrome-host',
    authorization: {
      status: conversations.length > 0 ? 'authorized' : 'empty',
      conversations: conversations.map((conversation) => ({
        authorizedAt: conversation.authorizedAt ?? '2026-09-01T00:00:00.000Z',
        updatedAt: conversation.updatedAt ?? conversation.authorizedAt ?? '2026-09-01T00:00:00.000Z',
        ...conversation,
      })),
    },
  };
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('CloudBindingRecoveryCard', () => {
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

  async function renderCard(overrides: Partial<React.ComponentProps<typeof CloudBindingRecoveryCard>> = {}) {
    await act(async () => {
      root.render(
        <CloudBindingRecoveryCard
          threadId="thread-one"
          sourceMessageId="source-one"
          targetCatId="gpt-pro"
          attemptId="attempt-one"
          {...overrides}
        />,
      );
    });
    await flushEffects();
  }

  it('preselects one authorized conversation and binds before retrying the exact source attempt', async () => {
    const conversationId = '6a928d55-ed7c-83ee-adbf-56bef0ffe336';
    mockApiFetch.mockImplementation(async (path, init) => {
      if (path === '/api/plugins/personal-chrome') {
        return jsonResponse(pluginState([{ conversationId, displayTitle: '太阳爪会话' }]));
      }
      if (path === '/api/threads/thread-one/cloud-bindings' && !init?.method) {
        return jsonResponse({ bindings: {} });
      }
      if (path === '/api/threads/thread-one/cloud-bindings' && init?.method === 'PATCH') {
        return jsonResponse({ bindings: { 'gpt-pro': `https://chatgpt.com/c/${conversationId}` } });
      }
      if (path === '/api/messages/source-one/queue-targets/gpt-pro/retry') {
        return jsonResponse({ status: 'retry_queued', attemptId: 'attempt-two' }, 202);
      }
      throw new Error(`unexpected ${String(path)}`);
    });

    await renderCard();

    expect(container.textContent).toContain('砚砚 Pro 尚未绑定到这个 Thread');
    expect(container.textContent).toContain('这条消息还没有发送');
    expect(container.textContent).toContain('太阳爪会话');
    expect(container.textContent).toContain('6a928d55…');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-recovery-primary]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockApiFetch).toHaveBeenCalledWith('/api/threads/thread-one/cloud-bindings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ catId: 'gpt-pro', chatUrl: `https://chatgpt.com/c/${conversationId}` }),
    });
    expect(mockApiFetch).toHaveBeenCalledWith('/api/messages/source-one/queue-targets/gpt-pro/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId: 'attempt-one' }),
    });
    expect(mockApiFetch.mock.calls.some(([path]) => path === '/api/messages')).toBe(false);
    expect(container.textContent).toContain('已绑定，正在发送');
  });

  it('requires an explicit inline choice when multiple conversations are authorized', async () => {
    mockApiFetch.mockImplementation(async (path) => {
      if (path === '/api/plugins/personal-chrome') {
        return jsonResponse(
          pluginState([
            { conversationId: 'conversation-one', displayTitle: '第一个会话' },
            { conversationId: 'conversation-two', displayTitle: '第二个会话' },
          ]),
        );
      }
      return jsonResponse({ bindings: {} });
    });

    await renderCard();

    expect(container.textContent).toContain('选择要绑定的 ChatGPT 会话');
    expect(container.querySelectorAll('input[name="cloud-recovery-conversation"]')).toHaveLength(2);
    expect(container.querySelector<HTMLButtonElement>('button[data-recovery-primary]')?.disabled).toBe(true);

    act(() => {
      container.querySelector<HTMLInputElement>('input[value="conversation-two"]')?.click();
    });
    expect(container.querySelector<HTMLButtonElement>('button[data-recovery-primary]')?.disabled).toBe(false);
  });

  it('hydrates a missing retry fence and makes title-less candidates distinguishable and inspectable', async () => {
    const olderId = '6a883fad-1111-2222-3333-444444444444';
    const newerId = '6a928d55-aaaa-bbbb-cccc-dddddddddddd';
    mockApiFetch.mockImplementation(async (path, init) => {
      const responses = new Map<string, Response>([
        [
          'GET /api/plugins/personal-chrome',
          jsonResponse(
            pluginState([
              {
                conversationId: olderId,
                authorizedAt: '2026-09-01T08:00:00.000Z',
                updatedAt: '2026-09-05T08:00:00.000Z',
              },
              { conversationId: newerId, authorizedAt: '2026-09-04T08:00:00.000Z' },
            ]),
          ),
        ],
        ['GET /api/threads/thread-one/cloud-bindings', jsonResponse({ bindings: {} })],
        [
          'GET /api/messages/source-one/queue-targets/gpt-pro/retry-authority',
          jsonResponse({ attemptId: 'attempt-hydrated' }),
        ],
        [
          'PATCH /api/threads/thread-one/cloud-bindings',
          jsonResponse({ bindings: { 'gpt-pro': `https://chatgpt.com/c/${newerId}` } }),
        ],
        [
          'POST /api/messages/source-one/queue-targets/gpt-pro/retry',
          jsonResponse({ status: 'retry_queued', attemptId: 'attempt-next' }, 202),
        ],
      ]);
      const response = responses.get(`${init?.method ?? 'GET'} ${path}`);
      if (!response) throw new Error(`unexpected ${String(path)}`);
      return response;
    });

    await renderCard({ attemptId: undefined });

    await act(async () => {
      await vi.waitFor(() => {
        expect(container.querySelectorAll('input[name="cloud-recovery-conversation"]')).toHaveLength(2);
      });
    });

    const choices = [...container.querySelectorAll<HTMLInputElement>('input[name="cloud-recovery-conversation"]')];
    expect(choices.map((choice) => choice.value)).toEqual([newerId, olderId]);
    expect(container.textContent).toContain('最近授权');
    expect(container.textContent).toContain('授权于');
    const inspectLinks = [...container.querySelectorAll<HTMLAnchorElement>('a[data-recovery-inspect-conversation]')];
    expect(inspectLinks.map((link) => link.href)).toEqual([
      `https://chatgpt.com/c/${newerId}`,
      `https://chatgpt.com/c/${olderId}`,
    ]);
    expect(inspectLinks.every((link) => link.target === '_blank' && link.rel === 'noopener noreferrer')).toBe(true);

    act(() => choices[0]?.click());
    const primary = container.querySelector<HTMLButtonElement>('button[data-recovery-primary]');
    expect(primary?.disabled).toBe(false);
    await act(async () => {
      primary?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockApiFetch).toHaveBeenCalledWith('/api/messages/source-one/queue-targets/gpt-pro/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attemptId: 'attempt-hydrated' }),
    });
  });

  it('opens ChatGPT only by owner click when no conversation has been authorized', async () => {
    mockApiFetch.mockImplementation(async (path) =>
      path === '/api/plugins/personal-chrome' ? jsonResponse(pluginState()) : jsonResponse({ bindings: {} }),
    );

    await renderCard();

    const openLink = container.querySelector<HTMLAnchorElement>('a[data-recovery-open-chatgpt]');
    expect(openLink?.getAttribute('href')).toBe('https://chatgpt.com/');
    expect(openLink?.getAttribute('target')).toBe('_blank');
    expect(container.textContent).toContain('打开 ChatGPT 授权会话');
    expect(mockApiFetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it('does not expose candidate or binding truth to an unauthorized viewer', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ error: 'forbidden' }, 403));

    await renderCard();

    expect(container.textContent).toContain('仅 Thread owner 可以绑定并发送');
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('button[data-recovery-primary]')).toBeNull();
  });

  it('ignores malformed conversation candidates instead of making them actionable', async () => {
    mockApiFetch.mockImplementation(async (path) => {
      if (path === '/api/plugins/personal-chrome') {
        return jsonResponse(
          pluginState([
            { conversationId: '../not-canonical', displayTitle: '坏候选' },
            { conversationId: 'conversation-safe', displayTitle: '\u0000坏标题' },
          ]),
        );
      }
      return jsonResponse({ bindings: {} });
    });

    await renderCard();

    expect(container.textContent).not.toContain('坏候选');
    expect(container.textContent).not.toContain('坏标题');
    expect(container.querySelector('code[title="conversation-safe"]')).not.toBeNull();
  });

  it('continues an already persisted exact route without writing it again', async () => {
    const conversationId = 'conversation-bound';
    mockApiFetch.mockImplementation(async (path, init) => {
      if (path === '/api/plugins/personal-chrome') return jsonResponse(pluginState([{ conversationId }]));
      if (path === '/api/threads/thread-one/cloud-bindings') {
        return jsonResponse({ bindings: { 'gpt-pro': `https://chatgpt.com/c/${conversationId}` } });
      }
      if (path === '/api/messages/source-one/queue-targets/gpt-pro/retry') {
        return jsonResponse({ status: 'retry_queued' }, 202);
      }
      throw new Error(`unexpected ${String(path)} ${String(init?.method)}`);
    });

    await renderCard();
    expect(container.textContent).toContain('当前 Thread 已绑定');
    expect(container.textContent).toContain('继续发送');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-recovery-primary]')?.click();
      await Promise.resolve();
    });

    expect(
      mockApiFetch.mock.calls.filter(([path, init]) => path.includes('/cloud-bindings') && init?.method === 'PATCH'),
    ).toHaveLength(0);
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/messages/source-one/queue-targets/gpt-pro/retry',
      expect.any(Object),
    );
  });

  it('keeps a successful route and offers exact retry again when queue admission fails', async () => {
    const conversationId = 'conversation-route-kept';
    mockApiFetch
      .mockResolvedValueOnce(jsonResponse(pluginState([{ conversationId }])))
      .mockResolvedValueOnce(jsonResponse({ bindings: {} }))
      .mockResolvedValueOnce(jsonResponse({ bindings: { 'gpt-pro': `https://chatgpt.com/c/${conversationId}` } }))
      .mockResolvedValueOnce(jsonResponse({ error: 'temporarily unavailable', code: 'QUEUE_RETRY_UNAVAILABLE' }, 503))
      .mockResolvedValueOnce(jsonResponse({ status: 'retry_queued' }, 202));

    await renderCard();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-recovery-primary]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('会话已绑定，但这条消息还没有重新发送');
    expect(container.textContent).toContain('继续发送');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[data-recovery-primary]')?.click();
      await Promise.resolve();
    });
    expect(
      mockApiFetch.mock.calls.filter(([path, init]) => path.includes('/cloud-bindings') && init?.method === 'PATCH'),
    ).toHaveLength(1);
    expect(
      mockApiFetch.mock.calls.filter(([path]) => path === '/api/messages/source-one/queue-targets/gpt-pro/retry'),
    ).toHaveLength(2);
  });
});
