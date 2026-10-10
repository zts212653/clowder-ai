import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { CloudBindingRecoveryCard } from '../CloudBindingRecoveryCard';

const container = document.createElement('div');
let root = createRoot(container);
const fetch = vi.mocked(apiFetch);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status });
const candidate = {
  conversationId: 'existing',
  authorizedAt: '2026-09-05T10:00:00.000Z',
  updatedAt: '2026-09-05T10:00:00.000Z',
};
const state = {
  artifact: { helper: 'ready' },
  authorization: { conversations: [candidate] },
  live: { status: 'dormant' },
};
function harness(
  plugin = state,
  refresh = {
    ...state,
    titleSync: { status: 'synced', updatedCount: 1, requestedCount: 1 },
    authorization: { conversations: [{ ...candidate, displayTitle: '刚同步的真实对话' }] },
  },
) {
  fetch.mockImplementation(async (path) => {
    if (path === '/api/plugins/personal-chrome/refresh-titles') return json(refresh);
    if (path === '/api/plugins/personal-chrome') return json(plugin);
    if (path.endsWith('/cloud-bindings')) return json({ bindings: {} });
    throw new Error(`unexpected request ${path}`);
  });
}
async function render(source = 'source') {
  await act(async () =>
    root.render(<CloudBindingRecoveryCard threadId="thread" sourceMessageId={source} targetCatId="gpt-pro" />),
  );
}
function refreshButton() {
  return [...container.querySelectorAll('button')].find((button) => button.textContent === '刷新名称与发送状态');
}
afterEach(() => {
  act(() => root.unmount());
  root = createRoot(container);
  vi.resetAllMocks();
});
afterAll(() => {
  act(() => root.unmount());
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it('manual refresh waits for fresh titles, coalesces duplicate clicks, and never rebinds or resends', async () => {
  harness();
  await render();
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  const button = refreshButton();
  expect(button).toBeDefined();
  await act(async () => {
    button?.click();
    button?.click();
  });
  expect(container.textContent).toContain('刚同步的真实对话');
  expect(container.textContent).toContain('已同步 1 个会话名称');
  expect(
    fetch.mock.calls.filter(([path, init]) => path.endsWith('/refresh-titles') && init?.method === 'POST'),
  ).toHaveLength(1);
  expect(fetch.mock.calls.some(([path, init]) => path.endsWith('/retry') || init?.method === 'PATCH')).toBe(false);
});

it('an older intact Helper exposes repair guidance while keeping existing authorized choices', async () => {
  harness({ ...state, artifact: { helper: 'stale' }, live: { status: 'stale_adapter' } });
  await render();
  expect(container.textContent).toContain('连接组件需要更新');
  expect(container.textContent).toContain('已有会话授权仍保留');
  expect(container.querySelector('a[href^="/settings"]')?.getAttribute('href')).toBe(
    '/settings?s=plugins&threadId=thread#personal-chatgpt-pro',
  );
  expect(container.textContent).not.toContain('重新点击扩展授权');
});

it('zero observed titles explains the next action without inventing a title or requesting another grant', async () => {
  harness(state, {
    ...state,
    titleSync: { status: 'synced', updatedCount: 0, requestedCount: 1 },
    authorization: { conversations: [{ ...candidate, displayTitle: '' }] },
  });
  await render();
  await act(async () => refreshButton()?.click());
  expect(container.textContent).toContain('未读到可同步的名称');
  expect(container.textContent).toContain('打开原对话');
  expect(container.textContent).not.toContain('重新点击扩展授权');
});

it('a delayed title refresh cannot overwrite a newly selected message identity', async () => {
  harness();
  await render();
  let resolveRefresh!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    resolveRefresh = resolve;
  });
  fetch.mockImplementation(async (path) => {
    if (path.endsWith('/refresh-titles')) return pending;
    if (path === '/api/plugins/personal-chrome')
      return json({
        ...state,
        authorization: {
          conversations: [{ ...candidate, displayTitle: '新卡片名称' }],
        },
      });
    if (path.endsWith('/cloud-bindings')) return json({ bindings: {} });
    return json({}, 404);
  });
  await act(async () => refreshButton()?.click());
  await render('new-source');
  await act(async () =>
    resolveRefresh(
      json({
        ...state,
        authorization: {
          conversations: [{ ...candidate, displayTitle: '旧请求迟到名称' }],
        },
        titleSync: { status: 'synced', updatedCount: 1, requestedCount: 1 },
      }),
    ),
  );
  expect(container.textContent).toContain('新卡片名称');
  expect(container.textContent).not.toContain('旧请求迟到名称');
  expect(fetch.mock.calls.filter(([path]) => path.endsWith('/refresh-titles'))).toHaveLength(1);
});

it('does not poll retired retry authority or start title observation', async () => {
  vi.useFakeTimers();
  try {
    fetch.mockImplementation(async (path) => {
      if (path === '/api/plugins/personal-chrome') return json(state);
      if (path.endsWith('/cloud-bindings')) return json({ bindings: {} });
      return json({ code: 'QUEUE_TARGET_NOT_RETRYABLE', targetState: 'queued' }, 409);
    });
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(fetch.mock.calls.filter(([path]) => path === '/api/plugins/personal-chrome')).toHaveLength(1);
    expect(fetch.mock.calls.some(([path]) => path.includes('retry-authority'))).toBe(false);
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
