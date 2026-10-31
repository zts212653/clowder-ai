import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import type { ConsoleEntry } from '../ConsolePanel';
import { ConsolePanel } from '../ConsolePanel';

Object.assign(globalThis as Record<string, unknown>, { React });

const entries: ConsoleEntry[] = [
  { level: 'log', args: ['hello world'], timestamp: 1000 },
  { level: 'info', args: ['fyi'], timestamp: 1500 },
  { level: 'warn', args: ['be careful'], timestamp: 2000 },
  { level: 'error', args: ['something broke'], timestamp: 3000 },
];

describe('ConsolePanel v2', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    writeShellPresentation('v2');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    writeShellPresentation('classic');
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function render(es: ConsoleEntry[] = entries) {
    act(() => {
      root.render(<ConsolePanel entries={es} onClear={() => {}} />);
    });
    return container;
  }

  it('renders Chinese title, level labels and filter chips', () => {
    const el = render();
    expect(el.textContent).toContain('控制台');
    expect(el.textContent).toContain('全部');
    expect(el.textContent).toContain('警告');
    expect(el.textContent).toContain('错误');
    expect(el.textContent).toContain('日志');
    expect(el.textContent).toContain('信息');
    expect(el.textContent).toContain('清空');
  });

  it('filters entries by level when a chip is selected', () => {
    const el = render();
    const errorChip = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.startsWith('错误'));
    expect(errorChip).toBeTruthy();
    act(() => {
      errorChip?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(el.textContent).toContain('something broke');
    expect(el.textContent).not.toContain('hello world');
    expect(el.textContent).not.toContain('be careful');
  });

  it('shows the Chinese empty state', () => {
    const el = render([]);
    expect(el.textContent).toContain('暂无控制台输出');
  });
});
