import type { PluginManagerListResponse } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { PluginCatalogCheck } from '../plugin-manager/PluginCatalogCheck';
import { usePluginCatalogCheck } from '../plugin-manager/usePluginCatalogCheck';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const api = vi.mocked(apiFetch);
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it.each(['degraded', 'unavailable'] as const)('folds raw %s diagnostics out of the notice body', (status) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const message = "Failed to execute 'json' on 'Response': Unexpected end of JSON input";
  const check = vi.fn();
  try {
    act(() =>
      root.render(
        <PluginCatalogCheck
          status={status}
          updates={0}
          onCheck={check}
          state={{
            checking: false,
            checked: true,
            failedSources: 1,
            lastSuccessfulAt: null,
            unavailable: status === 'unavailable',
            message,
          }}
        />,
      ),
    );
    const notice = container.querySelector(`[data-catalog-notice="${status}"]`);
    const visibleCopy = [...(notice?.children ?? [])]
      .filter((node) => node.tagName !== 'DETAILS')
      .map((node) => node.textContent)
      .join('');
    expect(visibleCopy).not.toContain(message);
    const detail = notice?.querySelector('details');
    expect(detail).not.toBeNull();
    expect(detail?.open).toBe(false);
    expect(detail?.querySelector('summary')?.textContent).toBe('技术详情 ›');
    expect(detail?.textContent).toContain(message);
    expect(notice?.hasAttribute('data-inline-notice')).toBe(true);
    act(() => notice?.querySelector<HTMLButtonElement>('button')?.click());
    expect(check).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it('keeps checking until the remote directory finishes, and preserves the last successful time on failure', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let remote!: (r: Response) => void;
  const remoteResult = new Promise<Response>((resolve) => {
    remote = resolve;
  });
  api
    .mockResolvedValueOnce(new Response(JSON.stringify({ sources: [{ status: 'ready' }] })))
    .mockReturnValueOnce(remoteResult);
  let snapshot: PluginManagerListResponse = { plugins: [], catalog: { status: 'fresh', refreshedAt: 1 } };
  const commit = vi.fn(async (value: PluginManagerListResponse) => {
    snapshot = value;
  });
  function Harness() {
    const { state, check } = usePluginCatalogCheck(commit);
    return (
      <PluginCatalogCheck state={state} onCheck={() => void check()} status={snapshot.catalog.status} updates={0} />
    );
  }
  await act(async () => root.render(<Harness />));
  await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());
  expect(container.textContent).toContain('正在检查插件目录');
  expect(commit).not.toHaveBeenCalled();
  const successAt = Date.now();
  await act(async () => {
    remote(new Response(JSON.stringify({ plugins: [], catalog: { status: 'fresh', refreshedAt: successAt } })));
    await remoteResult;
  });
  expect(container.textContent).toContain('都是最新的');
  api
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ sources: [{ status: 'error', error: 'source unavailable' }] })),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ plugins: [], catalog: { status: 'unavailable', refreshedAt: successAt + 600000 } }),
      ),
    );
  await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());
  const expectedTime = new Date(successAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  expect(container.textContent).toContain(`下面是 ${expectedTime} 读到的`);
  expect(container.textContent).toContain('已装的插件照常可以开关、修复、卸载');
  expect(container.textContent).not.toContain('都是最新的');
  act(() => root.unmount());
  container.remove();
});

it('does not equate HTTP200 or a fresh catalog with all marketplace sources succeeding', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  api
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ sources: [{ status: 'ready' }, { status: 'error', error: 'offline' }] })),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ plugins: [], catalog: { status: 'fresh', refreshedAt: Date.now() } })),
    );
  const commit = vi.fn<(value: PluginManagerListResponse) => Promise<void>>().mockResolvedValue(undefined);
  function Harness() {
    const { state, check } = usePluginCatalogCheck(commit);
    return <PluginCatalogCheck state={state} onCheck={() => void check()} status="fresh" updates={0} />;
  }
  await act(async () => root.render(<Harness />));
  await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());
  expect(container.textContent).toContain('有 1 个插件仓没读到');
  expect(commit.mock.calls[0][0].catalog.status).toBe('degraded');
  expect(container.textContent).not.toContain('都是最新的');
  act(() => root.unmount());
  container.remove();
});
