import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { PluginsContent } from '../PluginsContent';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';

const failed = {
  pluginId: 'official.failed-start',
  pluginInstanceId: 'pi_failed',
  displayName: '启动失败的插件',
  description: '此插件需要处理',
  source: { kind: 'local', trust: 'local-trusted' },
  artifact: 'installed',
  config: 'ready',
  auth: 'not-required',
  intent: 'disabled',
  live: 'stopped',
  activationFailed: true,
  installedVersion: '1.0.0',
  lifecycleRevision: 1,
  capabilitySummary: [],
  actions: { install: false, uninstall: true, setEnabled: true, blockingReasons: [] },
};
const catalog = { status: 'fresh', refreshedAt: 1 };
let host: HTMLDivElement;
let root: Root;
const fetch = vi.mocked(apiFetch);
const json = (value: unknown) => new Response(JSON.stringify(value));
const render = async () => act(async () => root.render(<PluginsContent />));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState(null, '', '/settings?s=plugins');
  writeShellPresentation('classic');
  fetch.mockReset();
  fetch.mockImplementation(async (path) => {
    if (path === '/api/plugin-manager/plugins') return json({ plugins: [failed], catalog });
    if (path === '/api/plugin-manager/plugins/official.failed-start')
      return json({ plugin: { ...failed, capabilities: [], configFields: [] }, catalog });
    if (path === '/api/plugins') return json({ plugins: [] });
    return new Response('{}', { status: 404 });
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  writeShellPresentation('classic');
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
});

it('uses the real Manager endpoint and v2 attention presentation from the persisted shell choice', async () => {
  writeShellPresentation('v2');
  await render();
  await vi.waitFor(() =>
    expect(host.querySelector('[data-plugin-section="attention"]')?.textContent).toContain('启动失败的插件'),
  );
  expect(fetch.mock.calls.some(([path]) => path === '/api/plugins')).toBe(false);
  expect(host.querySelector('[data-plugin-scroll-region="list"]')).not.toBeNull();
  expect(host.querySelector('[data-plugin-scroll-region="detail"]')).not.toBeNull();
});

it('uses the installed Manager in both shells without a second legacy plugin page', async () => {
  await render();
  await vi.waitFor(() => expect(host.querySelector('[data-plugin-id="official.failed-start"]')).not.toBeNull());
  expect(fetch.mock.calls.some(([path]) => path === '/api/plugins')).toBe(false);
  await act(async () => writeShellPresentation('v2'));
  await vi.waitFor(() => expect(host.querySelector('[data-plugin-section="attention"]')).not.toBeNull());
  await act(async () => writeShellPresentation('classic'));
  expect(host.querySelector('[data-testid="plugin-manager"]')).not.toBeNull();
});

it('retains the classic opt-in Manager without enabling v2 attention', async () => {
  window.history.replaceState(null, '', '/settings?s=plugins&pluginManagerLive=1');
  await render();
  await vi.waitFor(() => expect(host.querySelector('[data-plugin-id="official.failed-start"]')).not.toBeNull());
  expect(host.querySelector('[data-plugin-section="attention"]')).toBeNull();
});

it('shows a read failure in v2 without silently switching to the legacy list', async () => {
  writeShellPresentation('v2');
  fetch.mockResolvedValue(new Response('{}', { status: 503 }));
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain('插件列表加载失败'));
  expect(fetch.mock.calls.some(([path]) => path === '/api/plugins')).toBe(false);
});
