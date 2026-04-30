import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({
  apiFetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  API_URL: 'http://localhost:3102',
}));
vi.mock('@/stores/chatStore', () => {
  const hook = Object.assign(() => ({}), { getState: () => ({}) });
  return { useChatStore: hook };
});

import { SettingsNav } from '../settings/SettingsNav';

describe('SettingsNav search filtering', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders all 11 sections when no search query', () => {
    act(() => {
      root.render(React.createElement(SettingsNav, { activeSection: 'members', onSelect: vi.fn() }));
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons).toHaveLength(11);
    expect(container.textContent).toContain('规则与 SOP');
  });

  it('filters sections by label match', () => {
    act(() => {
      root.render(
        React.createElement(SettingsNav, { activeSection: 'members', onSelect: vi.fn(), searchQuery: '语音' }),
      );
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toContain('语音管理');
  });

  it('filters by keyword match (e.g. telegram matches IM 对接)', () => {
    act(() => {
      root.render(
        React.createElement(SettingsNav, { activeSection: 'members', onSelect: vi.fn(), searchQuery: 'telegram' }),
      );
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toContain('IM 对接');
  });

  it('filters governance keywords to the rules and SOP section', () => {
    act(() => {
      root.render(
        React.createElement(SettingsNav, { activeSection: 'members', onSelect: vi.fn(), searchQuery: '家规' }),
      );
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toContain('规则与 SOP');
  });

  it('shows empty message when no match', () => {
    act(() => {
      root.render(
        React.createElement(SettingsNav, { activeSection: 'members', onSelect: vi.fn(), searchQuery: 'zzzznotfound' }),
      );
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons).toHaveLength(0);
    expect(container.textContent).toContain('没有匹配的设置分区');
  });

  it('marks the active item with font-medium class for visual distinction', () => {
    act(() => {
      root.render(React.createElement(SettingsNav, { activeSection: 'voice', onSelect: vi.fn() }));
    });

    const buttons = Array.from(container.querySelectorAll('button'));
    const active = buttons.find((b) => b.textContent?.includes('语音管理'));
    expect(active).toBeTruthy();
    expect(active?.className).toContain('font-medium');
  });
});
