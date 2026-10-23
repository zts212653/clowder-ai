import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { PluginManagerNotices } from '../PluginManagerNotices';

it('renders an audit warning as status and keeps a real failure in the error channel', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const warning = '配置已保存，但插件审计写入失败';
  try {
    act(() => root.render(<PluginManagerNotices catalogStatus="fresh" warning={warning} />));
    expect(host.querySelector('[role="status"]')?.textContent).toBe(warning);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    act(() =>
      root.render(<PluginManagerNotices catalogStatus="fresh" warning={warning} error="恢复运行失败，请重试" />),
    );
    expect(host.querySelector('[role="status"]')?.textContent).toBe(warning);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('恢复运行失败，请重试');
    act(() => root.render(<PluginManagerNotices catalogStatus="fresh" />));
    expect(host.textContent).toBe('');
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
