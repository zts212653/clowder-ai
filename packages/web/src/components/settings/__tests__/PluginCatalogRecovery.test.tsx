import type { PluginManagerListItem } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { PluginCatalogCheck } from '../plugin-manager/PluginCatalogCheck';
import { PluginManagerLiveContent } from '../plugin-manager/PluginManagerLiveContent';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/useConfirm', () => ({
  useConfirm: () => async () => true,
  useOptionalConfirm: () => async () => true,
}));
const api = vi.mocked(apiFetch);
const item = (id: string, absent = false): PluginManagerListItem => ({
  pluginId: id,
  pluginInstanceId: absent ? null : id,
  displayName: id,
  source: { kind: 'catalog', catalogId: id, packageName: id, trust: 'official' },
  installedVersion: absent ? null : '1',
  availableVersion: '1',
  packageDigest: id,
  artifact: absent ? 'absent' : 'installed',
  config: 'ready',
  auth: 'not-required',
  intent: absent ? 'disabled' : 'enabled',
  live: absent ? 'stopped' : 'running',
  lifecycleRevision: absent ? null : 1,
  capabilitySummary: [],
  actions: { install: absent, repair: false, setEnabled: !absent, uninstall: !absent, blockingReasons: [] },
});
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)!;
const chooseAvailable = async () => {
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="选择插件范围"]')!.click());
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find((b) => b.textContent?.startsWith('可以安装'))!
      .click(),
  );
};

it('keeps catalog-derived counts unknown while the real local-first inventory waits for discovery', async () => {
  const installed = [item('first'), item('second'), item('third')];
  const available = [item('one', true), item('two', true), item('three', true)];
  let finishRemote!: () => void;
  const remote = new Promise<void>((resolve) => {
    finishRemote = resolve;
  });
  const json = (value: unknown) => new Response(JSON.stringify(value));
  api.mockImplementation(async (path) => {
    const p = String(path);
    if (p.endsWith('/marketplaces/refresh')) return json({ sources: [{ status: 'ready' }] });
    if (p.endsWith('/marketplaces')) return json({ sources: [] });
    if (p === '/api/plugin-manager/plugins/_local')
      return json({ plugins: installed, catalog: { status: 'loading', refreshedAt: null } });
    if (p === '/api/plugin-manager/plugins') {
      await remote;
      return json({ plugins: [...installed, ...available], catalog: { status: 'fresh', refreshedAt: Date.now() } });
    }
    const plugin = installed.find((p) => String(path).endsWith(`/${p.pluginId}`));
    return plugin
      ? json({
          plugin: { ...plugin, capabilities: [], configFields: [], bindings: [] },
          catalog: { status: 'loading', refreshedAt: null },
        })
      : json({});
  });
  await act(async () => root.render(<PluginManagerLiveContent presentation="v2" />));
  const scope = container.querySelector<HTMLButtonElement>('[aria-label="选择插件范围"]')!;
  expect(scope.textContent).toBe('全部 —');
  await act(async () => scope.click());
  const options = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
  expect(options.map((option) => option.textContent)).toEqual(['全部—', '需要处理—', '已安装3', '可以安装—']);
  await act(async () => options.find((option) => option.textContent?.startsWith('可以安装'))!.click());
  expect(container.textContent).toContain('正在读取插件目录…');
  expect(container.textContent).not.toContain('插件目录里的插件都装好了');
  await act(async () => {
    finishRemote();
    await remote;
  });
  expect(scope.textContent).toBe('可以安装 3');
  expect(container.querySelectorAll('[data-mobile-panel="list"] [data-plugin-id]')).toHaveLength(3);
});

it('keeps a failed first inventory read unknown instead of claiming a known empty inventory', async () => {
  api.mockImplementation(async () => new Response('{}', { status: 500 }));
  await act(async () => root.render(<PluginManagerLiveContent presentation="v2" />));
  expect(container.textContent).toContain('插件列表加载失败');
  const scope = container.querySelector<HTMLButtonElement>('[aria-label="选择插件范围"]')!;
  expect(scope.textContent).toBe('全部 —');
  await act(async () => scope.click());
  const options = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
  expect(options.map((option) => option.textContent)).toEqual(['全部—', '需要处理—', '已安装—', '可以安装—']);
  await act(async () => options.find((option) => option.textContent?.startsWith('可以安装'))!.click());
  expect(container.textContent).toContain('插件列表读不到');
  expect(container.textContent).not.toContain('插件目录里的插件都装好了');
});

it('expires the fresh result and renders its actual age while the page remains mounted', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-29T09:00:00Z'));
  await act(async () =>
    root.render(
      <PluginCatalogCheck
        status="fresh"
        updates={0}
        state={{ checking: false, checked: true, lastSuccessfulAt: Date.now(), failedSources: 0, unavailable: false }}
      />,
    ),
  );
  expect(container.textContent).toContain('刚查过 · 都是最新的');
  await act(async () => vi.advanceTimersByTime(120000));
  expect(container.textContent).toContain('插件目录 2 分钟前查过');
  expect(container.textContent).not.toContain('刚查过');
  await act(async () => vi.advanceTimersByTime(4 * 60 * 60000));
  expect(container.textContent).toContain('242 分钟前查过');
});

it('keeps candidates from the initial remote read when the first explicit check is unavailable', async () => {
  const installed = item('installed'),
    available = [item('one', true), item('two', true), item('three', true)];
  let unavailable = false;
  let finishRefresh!: () => void;
  const refresh = new Promise<void>((resolve) => {
    finishRefresh = resolve;
  });
  const json = (value: unknown) => new Response(JSON.stringify(value));
  api.mockImplementation(async (path) => {
    const p = String(path);
    if (p.endsWith('/marketplaces/refresh')) {
      await refresh;
      return json({ sources: [{ status: 'ready' }] });
    }
    if (p.endsWith('/marketplaces')) return json({ sources: [] });
    if (p === '/api/plugin-manager/plugins/_local')
      return json({ plugins: [installed], catalog: { status: 'fresh', refreshedAt: null } });
    if (p === '/api/plugin-manager/plugins')
      return json({
        plugins: unavailable ? [installed] : [installed, ...available],
        catalog: unavailable
          ? { status: 'unavailable', refreshedAt: null }
          : { status: 'fresh', refreshedAt: Date.now() },
      });
    if (/\/plugins\/(?:_local\/)?installed$/.test(p))
      return json({
        plugin: { ...installed, capabilities: [], configFields: [], bindings: [] },
        catalog: { status: 'fresh', refreshedAt: Date.now() },
      });
    return new Response('{}', { status: 404 });
  });
  await act(async () => root.render(<PluginManagerLiveContent presentation="v2" />));
  expect(container.querySelector('[aria-label="选择插件范围"]')?.textContent).toContain('4');
  unavailable = true;
  await act(async () => {
    finishRefresh();
    await refresh;
  });
  expect(container.querySelector('[aria-label="选择插件范围"]')?.textContent).toContain('4');
  expect(container.textContent).toContain('保留上次读到的列表');
  await chooseAvailable();
  expect(container.querySelectorAll('[data-mobile-panel="list"] [data-plugin-id]')).toHaveLength(3);
});

it.each([
  [200, 'fresh'],
  [500, 'fresh'],
  [200, 'degraded'],
] as const)('retains discovered candidates and disables install after a real unavailable response (%s, %s)', async (status, initialStatus) => {
  let unavailable = false;
  const installed = item('installed'),
    available = [item('available-1', true), item('available-2', true), item('available-3', true)];
  const successAt = Date.now();
  const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code });
  api.mockImplementation(async (path) => {
    const p = String(path);
    if (p.endsWith('/marketplaces/refresh')) return json({ sources: [{ status: 'ready' }] });
    if (p.endsWith('/marketplaces')) return json({ sources: [] });
    if (p === '/api/plugin-manager/plugins/_local')
      return json({ plugins: [installed], catalog: { status: 'fresh', refreshedAt: null } });
    if (p === '/api/plugin-manager/plugins')
      return unavailable
        ? json(
            {
              plugins: [installed],
              catalog: { status: 'unavailable', refreshedAt: null, message: 'Plugin catalog is unavailable.' },
            },
            status,
          )
        : json({ plugins: [installed, ...available], catalog: { status: initialStatus, refreshedAt: successAt } });
    if (/\/plugins\/(?:_local\/)?installed$/.test(p))
      return json({
        plugin: { ...installed, capabilities: [], configFields: [], bindings: [] },
        catalog: { status: initialStatus, refreshedAt: successAt },
      });
    return json({}, 404);
  });
  await act(async () => root.render(<PluginManagerLiveContent presentation="v2" />));
  expect(container.querySelector('[aria-label="选择插件范围"]')?.textContent).toContain('4');
  unavailable = true;
  await act(async () => button(initialStatus === 'fresh' ? '检查更新' : '再试一次').click());
  expect(container.querySelector('[aria-label="选择插件范围"]')?.textContent).toContain('4');
  const time = new Date(successAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (initialStatus === 'fresh') expect(container.textContent).toContain(`下面是 ${time} 读到的`);
  else expect(container.textContent).toContain('保留上次读到的列表');
  await chooseAvailable();
  expect(container.querySelectorAll('[data-mobile-panel="list"] [data-plugin-id]')).toHaveLength(3);
  expect(
    [...container.querySelectorAll<HTMLButtonElement>('[data-mobile-panel="list"] button')]
      .filter((b) => b.textContent?.trim() === '安装')
      .every((b) => b.disabled),
  ).toBe(true);
});
