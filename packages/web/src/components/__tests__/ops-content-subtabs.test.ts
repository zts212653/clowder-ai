import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({
  apiFetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  API_URL: 'http://localhost:3102',
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: () => null, cats: [] }),
  formatCatName: () => '',
}));
vi.mock('@/stores/chatStore', () => {
  const hook = Object.assign(() => ({}), { getState: () => ({}) });
  return { useChatStore: hook };
});

import { OpsContent } from '../settings/OpsContent';

describe('OpsContent sub-tabs', () => {
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

  it('renders all 6 subsection tabs', () => {
    act(() => {
      root.render(React.createElement(OpsContent));
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    const tabLabels = buttons.map((b) => b.textContent);
    expect(tabLabels).toContain('使用统计');
    expect(tabLabels).toContain('排行榜');
    expect(tabLabels).toContain('记忆索引');
    expect(tabLabels).toContain('系统健康');
    expect(tabLabels).toContain('命令速查');
    expect(tabLabels).toContain('紧急救援');
  });

  it('defaults to 使用统计 tab (first tab is active)', () => {
    act(() => {
      root.render(React.createElement(OpsContent));
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    const usageBtn = buttons.find((b) => b.textContent === '使用统计');
    expect(usageBtn?.className).toContain('bg-cafe-accent');
  });

  it('switches active tab on click', () => {
    act(() => {
      root.render(React.createElement(OpsContent));
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    const rescueBtn = buttons.find((b) => b.textContent === '紧急救援');
    expect(rescueBtn).not.toBeNull();

    act(() => {
      rescueBtn!.click();
    });

    expect(rescueBtn!.className).toContain('bg-cafe-accent');
    const usageBtn = buttons.find((b) => b.textContent === '使用统计');
    expect(usageBtn!.className).not.toContain('bg-cafe-accent');
  });
});
