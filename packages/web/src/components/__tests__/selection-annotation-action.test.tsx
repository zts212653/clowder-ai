import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SelectionAnnotationAction } from '@/components/SelectionAnnotationAction';

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('SelectionAnnotationAction', () => {
  let container: HTMLDivElement;
  let root: Root;
  let innerHeightDescriptor: PropertyDescriptor | undefined;
  let innerWidthDescriptor: PropertyDescriptor | undefined;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    innerHeightDescriptor = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    innerWidthDescriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth');
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
    if (innerHeightDescriptor) Object.defineProperty(window, 'innerHeight', innerHeightDescriptor);
    if (innerWidthDescriptor) Object.defineProperty(window, 'innerWidth', innerWidthDescriptor);
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function renderAction(
    onSave = vi.fn(),
    positionMode: 'fixed' | 'absolute' = 'fixed',
    onForward?: (comment: string) => void,
  ) {
    act(() => {
      root.render(
        <SelectionAnnotationAction
          selectedText={'A long selected passage. '.repeat(20)}
          position={{ top: 280, left: 560 }}
          positionMode={positionMode}
          actionTestId="selection-add-to-chat"
          onSave={onSave}
          onForward={onForward}
        />,
      );
    });
    const surfaceRoot = positionMode === 'fixed' ? document.body : container;
    act(() => surfaceRoot.querySelector<HTMLButtonElement>('[data-testid="selection-add-to-chat"]')?.click());
    return onSave;
  }

  it('portals fixed selection UI outside a contained message subtree', () => {
    container.style.contentVisibility = 'auto';
    renderAction();

    const editor = document.body.querySelector<HTMLElement>('[data-testid="context-annotation-editor"]');
    expect(editor).not.toBeNull();
    expect(container.contains(editor)).toBe(false);
  });

  it('keeps the editor action row inside the visible viewport near the bottom edge', () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 320 });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
    renderAction();

    const editor = document.body.querySelector<HTMLElement>('[data-testid="context-annotation-editor"]');
    if (!editor) throw new Error('annotation editor missing');
    const top = Number.parseFloat(editor.style.top);
    const maxHeight = Number.parseFloat(editor.style.maxHeight);
    expect(top + maxHeight).toBeLessThanOrEqual(window.innerHeight - 8);
    expect(editor.querySelector('[data-testid="context-annotation-scroll-region"]')).not.toBeNull();
    expect(editor.querySelector('[data-testid="context-annotation-actions"]')).not.toBeNull();
  });

  it('bounds a workspace editor by the remaining height of its positioned container', () => {
    renderAction(vi.fn(), 'absolute');

    const editor = container.querySelector<HTMLElement>('[data-testid="context-annotation-editor"]');
    if (!editor) throw new Error('workspace annotation editor missing');
    expect(editor.style.top).toBe('280px');
    expect(editor.style.maxHeight).toBe('calc(100% - 288px)');
  });

  it('saves a non-empty comment with plain Enter', () => {
    const onSave = renderAction();
    const comment = document.body.querySelector<HTMLTextAreaElement>('[data-testid="context-annotation-comment"]');
    if (!comment) throw new Error('annotation comment editor missing');
    expect(document.body.textContent).toContain('Enter 保存 · Shift+Enter 换行');
    act(() => setTextareaValue(comment, '  confirm this annotation  '));

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    act(() => comment.dispatchEvent(enter));

    expect(enter.defaultPrevented).toBe(true);
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith('confirm this annotation');
    expect(document.body.querySelector('[data-testid="context-annotation-editor"]')).toBeNull();
  });

  it('keeps Shift+Enter available for a multiline comment', () => {
    const onSave = renderAction();
    const comment = document.body.querySelector<HTMLTextAreaElement>('[data-testid="context-annotation-comment"]');
    if (!comment) throw new Error('annotation comment editor missing');
    act(() => setTextareaValue(comment, 'first line'));

    const shiftEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => comment.dispatchEvent(shiftEnter));

    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(onSave).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-testid="context-annotation-editor"]')).not.toBeNull();
  });

  it('does not save when Enter confirms an IME composition', () => {
    const onSave = renderAction();
    const comment = document.body.querySelector<HTMLTextAreaElement>('[data-testid="context-annotation-comment"]');
    if (!comment) throw new Error('annotation comment editor missing');
    act(() => setTextareaValue(comment, '中文批注'));
    act(() => comment.dispatchEvent(new Event('compositionstart', { bubbles: true })));
    act(() => comment.dispatchEvent(new Event('compositionend', { bubbles: true })));

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    act(() => comment.dispatchEvent(enter));

    expect(onSave).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-testid="context-annotation-editor"]')).not.toBeNull();
  });

  it('allows Forward with an empty Comment while keeping Add to chat Comment-required', () => {
    const onSave = vi.fn();
    const onForward = vi.fn();
    renderAction(onSave, 'fixed', onForward);

    const save = document.body.querySelector<HTMLButtonElement>('[data-testid="context-annotation-save"]');
    expect(save?.disabled).toBe(true);
    act(() => document.body.querySelector<HTMLButtonElement>('[data-testid="context-annotation-forward"]')?.click());

    expect(onForward).toHaveBeenCalledWith('');
    expect(onSave).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-testid="context-annotation-editor"]')).toBeNull();
  });
});
