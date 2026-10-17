import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/components/useConfirm', () => ({ useConfirm: () => vi.fn(), useOptionalConfirm: () => vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { PluginManagerLiveContent } from '../plugin-manager/PluginManagerLiveContent';

const fetch = vi.mocked(apiFetch);
const packagePath = '/workspace/plugins/local-example';
const installEndpoint = '/api/plugin-manager/plugins/install';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const listing = (current: string) => ({
  current,
  homePath: '/workspace/plugins',
  parent: '/workspace',
  name: 'plugins',
  entries: current === packagePath ? [] : [{ name: 'local-example', path: packagePath, isDirectory: true }],
});
let container: HTMLDivElement;
let root: Root;
let installResponse: () => Promise<Response>;
let directoryResponse: () => Promise<Response>;

function button(label: string) {
  const found = Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.trim() === label);
  expect(found, `Missing directory installation control: ${label}`).toBeDefined();
  return found as HTMLButtonElement;
}
const click = async (label: string) => act(async () => button(label).click());
const writes = () => fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
async function open(presentation: 'v1' | 'v2' = 'v1') {
  await act(async () => root.render(<PluginManagerLiveContent presentation={presentation} />));
  await click('从本地目录安装');
  await click('local-example');
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  window.localStorage.clear();
  fetch.mockReset();
  installResponse = async () => json({ pluginId: 'local-example' }, 201);
  directoryResponse = async () => json(listing(packagePath));
  fetch.mockImplementation(async (url, init) => {
    if (url === '/api/plugin-manager/plugins') return json({ plugins: [], catalog: { status: 'fresh' } });
    if (url === '/api/projects/browse' || url === '/api/projects/browse?path=%2Fworkspace%2Fplugins')
      return json(listing('/workspace/plugins'));
    if (url === `/api/projects/browse?path=${encodeURIComponent(packagePath)}`) return directoryResponse();
    if (url === installEndpoint && init?.method === 'POST') return installResponse();
    throw new Error(`Unexpected request: ${url}`);
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each([
  'v1',
  'v2',
] as const)('installs the selected directory through the real Manager seam and refreshes %s', async (presentation) => {
  await open(presentation);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(packagePath);
  expect(document.querySelector('[title="新建文件夹"]')).toBeNull();
  await click('安装插件');
  expect(writes()).toHaveLength(1);
  expect(writes()[0]).toEqual([
    installEndpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: { kind: 'local-directory', path: packagePath } }),
    },
    { mutationTimeoutMs: 600_000 },
  ]);
  expect(fetch.mock.calls.filter(([url]) => url === '/api/plugin-manager/plugins').length).toBeGreaterThan(1);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('keeps an admission refusal visible with the selected directory and never auto-enables', async () => {
  installResponse = async () => json({ error: '插件目录缺少可运行入口' }, 422);
  await open();
  await click('安装插件');
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain('插件目录缺少可运行入口');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(packagePath);
  expect(button('安装插件').disabled).toBe(false);
  expect(writes()).toHaveLength(1);
  await click('取消');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(writes()).toHaveLength(1);
});

it('does not submit the previous directory during navigation or after denied browsing', async () => {
  let resolve!: (response: Response) => void;
  directoryResponse = () =>
    new Promise((done) => {
      resolve = done;
    });
  await open();
  expect(button('安装插件').disabled).toBe(true);
  await click('安装插件');
  expect(writes()).toHaveLength(0);
  await act(async () => resolve(json({ error: 'Access denied' }, 403)));
  expect(button('安装插件').disabled).toBe(true);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Access denied');
  await click('取消');
  expect(writes()).toHaveLength(0);
});

it('admits one install at a time and keeps the dialog until its result arrives', async () => {
  let resolve!: (response: Response) => void;
  installResponse = () =>
    new Promise((done) => {
      resolve = done;
    });
  await open();
  const install = button('安装插件');
  await act(async () => {
    install.click();
    install.click();
  });
  expect(writes()).toHaveLength(1);
  expect(document.querySelector('[role="status"] .animate-spin')).not.toBeNull();
  expect(button('取消').disabled).toBe(true);
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => resolve(json({ pluginId: 'local-example' }, 201)));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('ignores an older browse response after the path input changes', async () => {
  let resolve!: (response: Response) => void;
  directoryResponse = () =>
    new Promise((done) => {
      resolve = done;
    });
  await open();
  const input = document.querySelector<HTMLInputElement>('[placeholder="Enter path..."]');
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '/workspace/another-plugin');
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => resolve(json(listing(packagePath))));
  expect(input?.value).toBe('/workspace/another-plugin');
  expect(button('安装插件').disabled).toBe(true);
  expect(writes()).toHaveLength(0);
});

it.each([
  'headers',
  'body',
] as const)('ignores a closed browser response arriving at %s after the dialog reopens', async (boundary) => {
  let releaseOld!: () => void;
  let releaseCurrent!: () => void;
  const currentPath = '/workspace/plugins/current-plugin';
  if (boundary === 'headers') {
    directoryResponse = () =>
      new Promise((resolve) => {
        releaseOld = () => resolve(json(listing(packagePath)));
      });
  } else {
    const response = json(listing(packagePath));
    vi.spyOn(response, 'json').mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseOld = () => resolve(listing(packagePath));
        }),
    );
    directoryResponse = async () => response;
  }
  await open();
  expect(releaseOld).toBeTypeOf('function');
  await click('取消');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  directoryResponse = () =>
    new Promise((resolve) => {
      releaseCurrent = () => resolve(json(listing(currentPath)));
    });
  await click('从本地目录安装');
  await click('local-example');
  expect(releaseCurrent).toBeTypeOf('function');
  expect(button('安装插件').disabled).toBe(true);
  await act(async () => releaseOld());
  expect(document.querySelector('[aria-live="polite"]')?.textContent).not.toContain(packagePath);
  expect(button('安装插件').disabled).toBe(true);
  await click('安装插件');
  expect(writes()).toHaveLength(0);
  await act(async () => releaseCurrent());
  expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain(currentPath);
  expect(button('安装插件').disabled).toBe(false);
  await click('安装插件');
  expect(writes()).toHaveLength(1);
  expect(JSON.parse(String(writes()[0]?.[1]?.body))).toEqual({
    source: { kind: 'local-directory', path: currentPath },
  });
});

it('remembers the last browsed concrete directory after close and remount', async () => {
  await open();
  await click('取消');
  await act(async () => {
    root.unmount();
    root = createRoot(container);
  });
  await act(async () => root.render(<PluginManagerLiveContent />));
  fetch.mockClear();
  await click('从本地目录安装');
  expect(fetch).toHaveBeenCalledWith(`/api/projects/browse?path=${encodeURIComponent(packagePath)}`);
  expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain(packagePath);
});

it.each([403, 404])('falls back visibly when the remembered directory is unavailable (%s)', async (status) => {
  await open();
  await click('取消');
  directoryResponse = async () => json({ error: 'Unavailable' }, status);
  await click('从本地目录安装');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('已切换到主目录');
  expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain('/workspace/plugins');
});

it('preserves a Windows server path and never installs the virtual drive picker', async () => {
  const windowsPath = 'D:\\plugins\\example';
  directoryResponse = async () =>
    json({
      current: windowsPath,
      homePath: 'C:\\Users\\owner',
      parent: 'D:\\plugins',
      name: 'example',
      entries: [],
      isWindows: true,
    });
  const previous = fetch.getMockImplementation();
  if (!previous) throw new Error('Missing browse fixture');
  fetch.mockImplementation(async (url, init) => {
    if (url === `/api/projects/browse?path=${encodeURIComponent(windowsPath)}`) return directoryResponse();
    if (String(url).includes('/api/projects/drives')) return json({ drives: [] });
    return previous(url, init);
  });
  await open();
  await click('取消');
  await click('从本地目录安装');
  expect(fetch).toHaveBeenCalledWith(`/api/projects/browse?path=${encodeURIComponent(windowsPath)}`);
  await click('安装插件');
  expect(JSON.parse(String(writes()[0]?.[1]?.body)).source.path).toBe(windowsPath);
  await click('从本地目录安装');
  const thisPC = Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.includes('此电脑'));
  expect(thisPC).toBeDefined();
  await act(async () => thisPC?.click());
  expect(button('安装插件').disabled).toBe(true);
});

it('refreshes actual inventory after a lost install response without claiming no change', async () => {
  installResponse = async () => {
    throw new DOMException('网络请求超时，请重试。', 'TimeoutError');
  };
  await open();
  const readsBefore = fetch.mock.calls.filter(
    ([url]) => String(url).includes('/api/plugin-manager/plugins') && url !== installEndpoint,
  ).length;
  await act(async () => button('安装插件').click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('安装结果尚未确认');
  expect(document.querySelector('[role="alert"]')?.textContent).not.toContain('请重试');
  expect(
    fetch.mock.calls.filter(([url]) => String(url).includes('/api/plugin-manager/plugins') && url !== installEndpoint)
      .length,
  ).toBeGreaterThan(readsBefore);
});
