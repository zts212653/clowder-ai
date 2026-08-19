import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInputAddMenu } from '@/components/ChatInputAddMenu';

describe('ChatInputAddMenu', () => {
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

  function render(props: Partial<React.ComponentProps<typeof ChatInputAddMenu>> = {}) {
    const defaults = {
      onAttach: vi.fn(),
      onAddContext: vi.fn(),
      onWhisperToggle: vi.fn(),
      onGameClick: vi.fn(),
      onClose: vi.fn(),
      ...props,
    };
    act(() => root.render(<ChatInputAddMenu {...defaults} />));
    return defaults;
  }

  it('groups context, upload and optional modes behind one menu', () => {
    render();
    expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(4);
    expect(container.textContent).toContain('引用 Thread 或文件');
    expect(container.textContent).toContain('上传附件');
    expect(container.textContent).toContain('图片、文档或压缩包，最多 5 个');
    expect(container.textContent).toContain('悄悄话');
    expect(container.textContent).toContain('游戏');
  });

  it('closes before routing a selected action', () => {
    const callbacks = render();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-add-context"]')?.click());
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
    expect(callbacks.onAddContext).toHaveBeenCalledTimes(1);
  });

  it('shows whisper as stateful only after the mode is active', () => {
    render({ whisperMode: true });
    const whisper = container.querySelector<HTMLButtonElement>('[data-testid="composer-whisper"]');
    expect(whisper?.className).toContain('bg-accent-50');
    expect(whisper?.textContent).toContain('已开启');
  });

  it('disables upload at the image limit without blocking context', () => {
    render({ maxImages: true });
    expect(container.querySelector<HTMLButtonElement>('[data-testid="composer-upload"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="composer-add-context"]')?.disabled).toBe(false);
  });

  it('closes from Escape without requiring focus inside the menu', () => {
    const callbacks = render();
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
  });
});
