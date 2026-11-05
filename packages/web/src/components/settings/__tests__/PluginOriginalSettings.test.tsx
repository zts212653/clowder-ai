import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import PluginConnectorSettings from '../plugin-manager/PluginConnectorSettings';
import { PluginManagerConfigurationSection } from '../plugin-manager/PluginManagerConfigurationSection';
import { PLUGIN_MANAGER_DESIGN_FIXTURES } from '../plugin-manager/plugin-manager-fixtures';

const fetch = vi.mocked(apiFetch);
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fetch.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const config = {
  revision: 3,
  whitelistEnabled: false,
  commandAdminOnly: false,
  adminOpenIds: ['admin'],
  allowedGroups: [{ externalChatId: 'group', label: 'Team', addedAt: 10 }],
};
it('original group controls auto-read and save internally without JSON/import/apply steps or enable changes', async () => {
  fetch
    .mockResolvedValueOnce(new Response(JSON.stringify(config)))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...config, revision: 4, whitelistEnabled: true })));
  await act(async () => root.render(<PluginConnectorSettings pluginId="demo" />));
  expect(fetch).toHaveBeenCalledWith('/api/plugin-manager/plugins/demo/permissions');
  for (const label of ['JSON', '读取当前权限', '应用权限设置', '导入旧权限'])
    expect(container.textContent).not.toContain(label);
  const toggle = container.querySelector<HTMLButtonElement>('button[title="开启白名单"]');
  expect(toggle).not.toBeNull();
  await act(async () => toggle?.click());
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ expectedRevision: 3, whitelistEnabled: true });
  expect(container.textContent).toContain('Team');
  expect(container.textContent).toContain('已保存');
});
it('QR-only setup renders declared guidance and action without an extra configuration step', async () => {
  fetch.mockResolvedValue(new Response(JSON.stringify({ currentAction: 'generate' })));
  await act(async () =>
    root.render(
      <PluginManagerConfigurationSection
        plugin={{
          ...PLUGIN_MANAGER_DESIGN_FIXTURES[0],
          steps: ['点击生成二维码', '扫描并确认授权'],
          configFields: [
            {
              key: 'qr',
              kind: 'operation',
              label: '扫码',
              required: false,
              sensitive: false,
              currentValue: null,
              actions: [{ id: 'generate', label: '生成二维码', render: 'button' }],
            },
          ],
        }}
        busy={false}
        validationRequest={0}
        saved={false}
      />,
    ),
  );
  expect(container.textContent).toContain('点击生成二维码');
  expect(container.textContent).toContain('扫描并确认授权');
  expect(container.textContent).not.toContain('填写插件配置');
});
it('mode instructions follow the matching select value including an unsaved mode change', async () => {
  await act(async () =>
    root.render(
      <PluginManagerConfigurationSection
        plugin={{
          ...PLUGIN_MANAGER_DESIGN_FIXTURES[0],
          steps: [
            { text: 'Webhook instructions', mode: 'webhook' },
            { text: 'Websocket instructions', mode: 'websocket' },
          ],
          configFields: [
            {
              key: 'connectionMode',
              kind: 'select',
              label: '连接模式',
              required: false,
              sensitive: false,
              currentValue: 'webhook',
              options: [
                { value: 'webhook', label: 'Webhook' },
                { value: 'websocket', label: 'Websocket' },
              ],
            },
          ],
        }}
        busy={false}
        validationRequest={0}
        saved={false}
      />,
    ),
  );
  expect(container.textContent).toContain('Webhook instructions');
  expect(container.textContent).not.toContain('Websocket instructions');
  const select = container.querySelector('select')!;
  await act(async () => {
    select.value = 'websocket';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(container.textContent).toContain('Websocket instructions');
  expect(container.textContent).not.toContain('Webhook instructions');
});

it('does not offer source or version switching in installed plugin details', async () => {
  const { PluginManagerDetailCard } = await import('../plugin-manager/PluginManagerDetailCard');
  await act(async () =>
    root.render(
      <PluginManagerDetailCard plugin={{ ...PLUGIN_MANAGER_DESIGN_FIXTURES[0], configFields: [] }} locale="zh-CN" />,
    ),
  );
  expect(container.querySelector('select[aria-label="安装来源"]')).toBeNull();
  expect(container.textContent).not.toContain('替换为此版本');
  expect(container.textContent).not.toContain('从此来源安装');
});
