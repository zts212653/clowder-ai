import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TagEditor } from '@/components/hub-tag-editor';

describe('TagEditor IME guard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
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
    vi.restoreAllMocks();
  });

  it('does not commit when pressing Enter during IME composition', async () => {
    const onChange = vi.fn();
    let tags: string[] = [];
    const render = () =>
      root.render(
        <TagEditor
          tags={tags}
          onChange={(next) => {
            tags = next;
            onChange(next);
            render();
          }}
          addLabel="+ 添加模型"
          placeholder="输入模型名"
          emptyLabel="(暂无模型)"
        />,
      );

    await act(async () => {
      render();
    });

    const addButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('+ 添加模型'),
    ) as HTMLButtonElement | undefined;
    if (!addButton) throw new Error('Missing add button');

    await act(async () => {
      addButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const input = container.querySelector('input') as HTMLInputElement | null;
    if (!input) throw new Error('Missing tag input');

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'openai/gpt-5.4');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('openai/gpt-5.4');
  });
});
