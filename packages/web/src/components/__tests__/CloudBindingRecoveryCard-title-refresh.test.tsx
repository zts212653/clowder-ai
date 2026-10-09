import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { CloudBindingRecoveryCard } from '../CloudBindingRecoveryCard';
import { packageRows } from './cloud-route-test-fixtures';

const container = document.createElement('div');
let root = createRoot(container);
const fetch = vi.mocked(apiFetch);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status });
const base = '/api/plugins/official.companion.personal-chrome/actions/personalChromeAuthorizations/';
function harness(helper = 'connected', updatedCount = 1) {
  let refreshed = false;
  fetch.mockImplementation(async (path) => {
    if (path === base + 'refresh-titles') {
      refreshed = true;
      return json({
        ok: true,
        render: 'status',
        data: { titleSync: { status: 'synced', updatedCount, requestedCount: 1 } },
      });
    }
    if (path === base + 'list')
      return json(
        packageRows([
          { conversationId: 'existing', ...(refreshed && updatedCount ? { displayTitle: '刚同步的真实对话' } : {}) },
        ]),
      );
    if (path === base + 'status') return json({ ok: true, data: { helper: { state: helper } } });
    if (path.endsWith('/cloud-bindings')) return json({ bindings: {} });
    if (path.endsWith('/retry-authority')) return json({}, 404);
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
  expect(fetch.mock.calls.some(([path]) => path.endsWith('/refresh-titles'))).toBe(false);
  const button = refreshButton();
  expect(button).toBeDefined();
  await act(async () => {
    button?.click();
    button?.click();
  });
  expect(container.textContent).toContain('刚同步的真实对话');
  expect(container.textContent).toContain('已同步 1 个会话名称');
  expect(fetch.mock.calls.filter(([path]) => path.endsWith('/refresh-titles'))).toHaveLength(1);
  expect(fetch.mock.calls.some(([path, init]) => path.endsWith('/retry') || init?.method === 'PATCH')).toBe(false);
});
it('invalid helper exposes package repair guidance while retaining authorized choices', async () => {
  harness('invalid_installation');
  await render();
  expect(container.textContent).toContain('连接组件需要更新');
  expect(container.querySelector('a[href^="/settings"]')?.getAttribute('href')).toBe(
    '/settings?s=plugins&pluginManagerLive=1&plugin=official.companion.personal-chrome',
  );
  expect(container.textContent).not.toContain('重新点击扩展授权');
});
it('zero titles does not invent a name or request another grant', async () => {
  harness('connected', 0);
  await render();
  await act(async () => refreshButton()?.click());
  expect(container.textContent).toContain('未读到可同步的名称');
  expect(container.textContent).toContain('打开原对话');
});
it('an old title refresh cannot overwrite a new message identity or start its follow-up list', async () => {
  harness();
  await render();
  let resolveRefresh!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    resolveRefresh = resolve;
  });
  fetch.mockImplementation(async (path) => {
    if (path.endsWith('/refresh-titles')) return pending;
    if (path === base + 'list') return json(packageRows([{ conversationId: 'existing', displayTitle: '新卡片名称' }]));
    if (path.endsWith('/cloud-bindings')) return json({ bindings: {} });
    return json({}, 404);
  });
  await act(async () => refreshButton()?.click());
  await render('new-source');
  const listCount = fetch.mock.calls.filter(([path]) => path === base + 'list').length;
  await act(async () =>
    resolveRefresh(json({ ok: true, data: { titleSync: { status: 'synced', updatedCount: 1, requestedCount: 1 } } })),
  );
  expect(container.textContent).toContain('新卡片名称');
  expect(fetch.mock.calls.filter(([path]) => path === base + 'list')).toHaveLength(listCount);
});
it('pending delivery polling only invokes read actions and never title observation', async () => {
  vi.useFakeTimers();
  try {
    fetch.mockImplementation(async (path) => {
      if (path === base + 'list') return json(packageRows([{ conversationId: 'existing' }]));
      if (path === base + 'status') return json({ ok: true, data: { helper: { state: 'connected' } } });
      if (path.endsWith('/cloud-bindings')) return json({ bindings: {} });
      return json({ code: 'QUEUE_TARGET_NOT_RETRYABLE', targetState: 'queued' }, 409);
    });
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(fetch.mock.calls.filter(([path]) => path === base + 'list')).toHaveLength(2);
    expect(fetch.mock.calls.some(([path]) => path.endsWith('/refresh-titles') || path.endsWith('/retry'))).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
