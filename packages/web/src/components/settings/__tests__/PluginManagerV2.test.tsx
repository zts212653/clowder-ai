import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginManagerContent } from '../plugin-manager/PluginManagerContent';
import {
  PLUGIN_MANAGER_DESIGN_FIXTURES,
  type PluginManagerDesignFixture,
} from '../plugin-manager/plugin-manager-fixtures';

const ready = PLUGIN_MANAGER_DESIGN_FIXTURES[0];
const failed: PluginManagerDesignFixture = {
  ...ready,
  id: 'failed',
  displayName: '启动失败插件',
  live: 'crashed',
  diagnostic: '连接被拒绝',
};
const candidate = PLUGIN_MANAGER_DESIGN_FIXTURES[2];

describe('Plugin Manager v2 presentation', () => {
  let container: HTMLDivElement;
  let root: Root;
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

  it('puts an installed runtime failure first, once, with its actual reason', () => {
    act(() => root.render(<PluginManagerContent presentation="v2" fixtures={[ready, candidate, failed]} />));
    expect(
      [...container.querySelectorAll('[data-plugin-section]')].map((node) => node.getAttribute('data-plugin-section')),
    ).toEqual(['attention', 'installed', 'recommended']);
    const row = container.querySelector('[data-plugin-section="attention"] [data-plugin-id="failed"]');
    expect(row?.textContent).toContain('连接被拒绝');
    expect(row?.getAttribute('aria-current')).toBe('true');
    expect(container.querySelectorAll('[data-plugin-id="failed"]')).toHaveLength(1);
  });

  it.each([
    { config: 'incomplete', expected: '配置尚未完成' },
    { config: 'invalid', expected: '配置无效' },
    { auth: 'expired', expected: '授权已过期' },
    { auth: 'error', expected: '授权失败' },
    { live: 'degraded', expected: '运行受限' },
    { artifact: 'quarantined', expected: '安装包已隔离' },
    { artifact: 'staged', expected: '安装尚未完成' },
    { artifact: 'verified', expected: '安装尚未完成' },
    { auth: 'pending', expected: '等待完成授权' },
    { auth: 'disconnected', expected: '尚未连接授权' },
    { live: 'stopped', expected: '已启用，但尚未运行' },
  ] as const)('explains state $expected without inventing a runtime diagnostic', ({ expected, ...state }) => {
    act(() => root.render(<PluginManagerContent presentation="v2" fixtures={[{ ...ready, ...state }]} />));
    expect(container.querySelector('[data-plugin-section="attention"]')?.textContent).toContain(expected);
  });

  it('does not promote uninstalled candidates, intentionally disabled plugins or normal startup', () => {
    const disabled: PluginManagerDesignFixture = {
      ...ready,
      id: 'disabled',
      intent: 'disabled',
      live: 'stopped',
      auth: 'disconnected',
      diagnostic: '上次启动失败的历史记录',
    };
    act(() =>
      root.render(
        <PluginManagerContent presentation="v2" fixtures={[candidate, disabled, { ...ready, live: 'starting' }]} />,
      ),
    );
    expect(container.querySelector('[data-plugin-section="attention"]')).toBeNull();
    expect(container.querySelectorAll('[data-plugin-section="installed"] [data-plugin-id]')).toHaveLength(2);
  });

  it('keeps classic grouping and descriptions unchanged when the host does not opt in', () => {
    act(() => root.render(<PluginManagerContent fixtures={[ready, failed]} />));
    expect(container.querySelector('[data-plugin-section="attention"]')).toBeNull();
    expect(container.querySelector('[data-plugin-description]')?.className).toContain('line-clamp-2');
  });

  it('uses a single-line description and keeps uninstall keyboard reachable', () => {
    const onUninstall = vi.fn();
    act(() =>
      root.render(<PluginManagerContent presentation="v2" fixtures={[ready, failed]} onUninstall={onUninstall} />),
    );
    const row = container.querySelector('[data-plugin-id="github"]');
    expect(row?.querySelector('[data-plugin-description]')?.className).toContain('truncate');
    const uninstall = row?.querySelector('button[aria-label="卸载GitHub"]') as HTMLButtonElement;
    expect(uninstall.tabIndex).toBe(0);
    expect(uninstall.disabled).toBe(false);
    act(() => {
      uninstall.focus();
      uninstall.click();
    });
    expect(onUninstall).toHaveBeenCalledWith('github');
  });

  it('preserves server action permissions in the attention group', () => {
    const plugin = {
      ...failed,
      actions: { install: false, setEnabled: false, uninstall: false, blockingReasons: ['policy'] },
    };
    act(() => root.render(<PluginManagerContent presentation="v2" fixtures={[plugin]} />));
    const row = container.querySelector('[data-plugin-id="failed"]');
    expect(row?.textContent).toContain('连接被拒绝');
    expect(row?.querySelector('[data-plugin-uninstall]')).toBeNull();
  });
});
