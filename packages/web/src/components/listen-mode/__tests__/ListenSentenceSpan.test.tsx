import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ListenSentenceSpan } from '../ListenSentenceSpan';

describe('ListenSentenceSpan', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('starts the intended sentence by click, Enter, or Space', () => {
    const onStart = vi.fn();
    act(() =>
      root.render(
        <ListenSentenceSpan anchor="sentence-a" index={4} active={false} onStart={onStart}>
          第五句。
        </ListenSentenceSpan>,
      ),
    );
    const sentence = container.querySelector<HTMLElement>('[data-listen-sentence-anchor="sentence-a"]');
    expect(sentence).not.toBeNull();

    act(() => sentence?.click());
    act(() => sentence?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    act(() => sentence?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })));

    expect(onStart).toHaveBeenNthCalledWith(1, 4);
    expect(onStart).toHaveBeenNthCalledWith(2, 4);
    expect(onStart).toHaveBeenNthCalledWith(3, 4);
  });

  it('does not start playback while the user is selecting text', () => {
    const onStart = vi.fn();
    vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => '第五句' } as Selection);
    act(() =>
      root.render(
        <ListenSentenceSpan anchor="sentence-a" index={4} active={false} onStart={onStart}>
          第五句。
        </ListenSentenceSpan>,
      ),
    );

    act(() => container.querySelector<HTMLElement>('[data-listen-sentence-anchor]')?.click());

    expect(onStart).not.toHaveBeenCalled();
  });

  it('uses the reading-surface accent instead of the dark editor chrome hover token', () => {
    act(() =>
      root.render(
        <ListenSentenceSpan anchor="sentence-a" index={0} active={false} onStart={vi.fn()}>
          正文句子。
        </ListenSentenceSpan>,
      ),
    );

    const sentence = container.querySelector<HTMLElement>('[data-listen-sentence-anchor]');
    expect(sentence?.className).toContain('var(--cafe-accent)_8%');
    expect(sentence?.className).not.toContain('ws-editor-hover');
  });
});
