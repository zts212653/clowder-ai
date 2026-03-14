import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileInputToolbar } from '@/components/MobileInputToolbar';

describe('MobileInputToolbar', () => {
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

  function render(props: Partial<React.ComponentProps<typeof MobileInputToolbar>> = {}) {
    const defaults = {
      onAttach: vi.fn(),
      onWhisperToggle: vi.fn(),
      onGameClick: vi.fn(),
      onClose: vi.fn(),
      ...props,
    };
    act(() => {
      root.render(React.createElement(MobileInputToolbar, defaults));
    });
    return defaults;
  }

  it('renders three action buttons', () => {
    render();
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(3);
    expect(container.textContent).toContain('附件');
    expect(container.textContent).toContain('悄悄话');
    expect(container.textContent).toContain('游戏');
  });

  it('calls onAttach + onClose when attach button is clicked', () => {
    const fns = render();
    const attachBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('附件'));
    act(() => {
      attachBtn?.click();
    });
    expect(fns.onAttach).toHaveBeenCalledTimes(1);
    expect(fns.onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onWhisperToggle + onClose when whisper button is clicked', () => {
    const fns = render();
    const whisperBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('悄悄话'));
    act(() => {
      whisperBtn?.click();
    });
    expect(fns.onWhisperToggle).toHaveBeenCalledTimes(1);
    expect(fns.onClose).toHaveBeenCalledTimes(1);
  });

  it('disables buttons when disabled prop is set', () => {
    render({ disabled: true });
    const buttons = container.querySelectorAll('button');
    const whisperBtn = Array.from(buttons).find((b) => b.textContent?.includes('悄悄话'));
    expect(whisperBtn?.disabled).toBe(true);
  });

  it('applies whisper-active styling when whisperMode is true', () => {
    render({ whisperMode: true });
    const whisperBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('悄悄话'));
    expect(whisperBtn?.className).toContain('amber');
  });
});
