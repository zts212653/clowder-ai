import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PluginManagerContent } from '../plugin-manager/PluginManagerContent';
import { PLUGIN_MANAGER_DESIGN_FIXTURES } from '../plugin-manager/plugin-manager-fixtures';

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
  vi.unstubAllGlobals();
});

it('distinguishes unknown loading counts from a known empty inventory', () => {
  act(() => root.render(<PluginManagerContent presentation="v2" fixtures={[]} loading />));
  const select = container.querySelector<HTMLButtonElement>('[aria-label="选择插件范围"]');
  expect(select?.textContent).toBe('全部 —');
  expect(container.textContent).toContain('插件目录 · 检查更新');
  act(() => select?.click());
  expect([...container.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent)).toEqual([
    '全部—',
    '需要处理—',
    '已安装—',
    '可以安装—',
  ]);
  act(() => root.render(<PluginManagerContent presentation="v2" fixtures={[]} loading={false} />));
  expect(select?.textContent).toBe('全部 0');
  expect([...container.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent)).toEqual([
    '全部0',
    '需要处理0',
    '已安装0',
    '可以安装0',
  ]);
  act(() => root.render(<PluginManagerContent presentation="v2" fixtures={PLUGIN_MANAGER_DESIGN_FIXTURES} />));
  expect(select?.textContent).toBe(`全部 ${PLUGIN_MANAGER_DESIGN_FIXTURES.length}`);
});

it('finds every installable plugin directly and searches the full catalog from any filter', () => {
  const available = Array.from({ length: 8 }, (_, i) => ({
    ...PLUGIN_MANAGER_DESIGN_FIXTURES[0],
    id: `available-${i}`,
    displayName: `Available ${i}`,
    artifact: 'absent' as const,
    installedVersion: null,
  }));
  act(() =>
    root.render(
      <PluginManagerContent presentation="v2" fixtures={[PLUGIN_MANAGER_DESIGN_FIXTURES[0], ...available]} />,
    ),
  );
  const select = container.querySelector<HTMLButtonElement>('[aria-label="选择插件范围"]');
  expect(select).not.toBeNull();
  act(() => select?.click());
  const option = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((item) =>
    item.textContent?.includes('可以安装'),
  );
  act(() => option?.click());
  expect(container.querySelectorAll('[data-plugin-list-row]')).toHaveLength(8);
  expect(container.textContent).not.toContain('查看更多');
  const input = container.querySelector<HTMLInputElement>('input[aria-label="搜索全部插件"]');
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, 'GitHub');
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(container.querySelector('[data-plugin-id="github"]')).not.toBeNull();
});

it('routes incomplete configuration to details instead of repairing or updating it', () => {
  const install = vi.fn(),
    repair = vi.fn();
  const plugin = {
    ...PLUGIN_MANAGER_DESIGN_FIXTURES[0],
    config: 'incomplete' as const,
    actions: { install: true, repair: true, uninstall: true, setEnabled: false, blockingReasons: [] },
  };
  act(() =>
    root.render(<PluginManagerContent presentation="v2" fixtures={[plugin]} onInstall={install} onRepair={repair} />),
  );
  const row = container.querySelector('[data-plugin-id="github"]');
  expect(row?.textContent).toContain('去填写');
  act(() => row?.querySelector<HTMLButtonElement>('[data-plugin-primary-action]')?.click());
  expect(install).not.toHaveBeenCalled();
  expect(repair).not.toHaveBeenCalled();
});
