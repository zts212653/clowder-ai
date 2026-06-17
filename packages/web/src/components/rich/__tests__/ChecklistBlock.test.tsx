import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RichChecklistBlock } from '@/stores/chat-types';
import { ChecklistBlock } from '../ChecklistBlock';

Object.assign(globalThis as Record<string, unknown>, { React });

const block: RichChecklistBlock = {
  id: 'cl1',
  kind: 'checklist',
  v: 1,
  title: '验证步骤',
  items: [
    { id: 'a', text: '建 worktree', checked: true },
    { id: 'b', text: '跑测试', checked: false },
  ],
};

describe('ChecklistBlock (F225 猫猫化 — ☑ ☐ → CafeIcon SVG)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
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

  it('renders checkbox state as SVG icons, not ☑/☐ glyphs', () => {
    act(() => root.render(<ChecklistBlock block={block} />));
    expect(container.textContent).not.toContain('☑');
    expect(container.textContent).not.toContain('☐');
    // one SVG per item (checked → check-square, unchecked → square)
    expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2);
  });

  it('keeps item text and checked (line-through) styling', () => {
    act(() => root.render(<ChecklistBlock block={block} />));
    expect(container.textContent).toContain('建 worktree');
    expect(container.textContent).toContain('跑测试');
    expect(container.querySelector('.line-through')?.textContent).toContain('建 worktree');
  });
});
