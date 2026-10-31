import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const themes = vi.hoisted(() => ({
  state: {
    themes: [
      { id: 'light', name: 'Light', base: 'light', builtIn: true },
      { id: 'dark', name: 'Dark', base: 'dark', builtIn: true },
    ] as Array<{ id: string; name: string; base: string; builtIn: boolean }>,
    activeId: 'light',
    setActive: vi.fn(),
    deleteCustom: vi.fn(),
    createCustom: vi.fn(() => 'custom-1'),
  },
}));
vi.mock('@/stores/themeStore', () => ({ useThemeStore: () => themes.state }));
vi.mock('../../dev/OklchTuner', () => ({ OklchTuner: () => <div data-testid="tuner" /> }));

import { readShellPresentation, writeShellPresentation } from '../../shell/shell-presentation';
import { ThemeSettingsPanel } from '../ThemeSettingsPanel';

describe('F322 主题 in 设置与管理', () => {
  let host: HTMLDivElement;
  let root: Root;
  const render = () => act(() => root.render(<ThemeSettingsPanel />));
  const click = (selector: string) => act(() => host.querySelector<HTMLElement>(selector)?.click());
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    themes.state.themes = [
      { id: 'light', name: 'Light', base: 'light', builtIn: true },
      { id: 'dark', name: 'Dark', base: 'dark', builtIn: true },
    ];
    themes.state.activeId = 'light';
    writeShellPresentation('v2');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    writeShellPresentation('classic');
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('drives the existing theme store: pick a preset, nothing is kept locally', () => {
    render();
    click('[data-testid="theme-dark"]');
    expect(themes.state.setActive).toHaveBeenCalledWith('dark');
    expect(host.querySelector('[data-testid="theme-light"]')?.getAttribute('aria-checked')).toBe('true');
  });

  it('editing a preset selects it and opens the colour tuner', async () => {
    render();
    click('button[aria-label="编辑 Dark"]');
    expect(themes.state.setActive).toHaveBeenCalledWith('dark');
    // the tuner is lazy-loaded, exactly like the old rail's theme menu
    await vi.waitFor(() => expect(host.querySelector('[data-testid="tuner"]')).not.toBeNull());
  });

  it('allows a new theme until two custom ones exist, and only custom themes can be deleted', () => {
    render();
    expect(host.textContent).toContain('新建主题');
    expect(host.querySelector('button[aria-label="删除 Dark"]')).toBeNull();
    themes.state.themes = [
      ...themes.state.themes,
      { id: 'c1', name: '自定义 1', base: 'light', builtIn: false },
      { id: 'c2', name: '自定义 2', base: 'light', builtIn: false },
    ];
    render();
    expect(host.textContent).not.toContain('新建主题');
    click('button[aria-label="删除 自定义 1"]');
    expect(themes.state.deleteCustom).toHaveBeenCalledWith('c1');
  });

  it('界面版本 switches the single presentation preference both ways', () => {
    render();
    click('[data-testid="shell-presentation-classic"]');
    expect(readShellPresentation()).toBe('classic');
    click('[data-testid="shell-presentation-v2"]');
    expect(readShellPresentation()).toBe('v2');
  });
});
