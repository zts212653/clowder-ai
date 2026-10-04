import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MessageBubble } from '../MessageBubble';

/**
 * F322 B segment 1 — the one explicit seam MessageBubble gives the new cat presentation.
 *
 * The primitive is shared by cat, connector and co-creator messages. Its default must stay what it was; only a
 * caller that asks for `presentation="nameplate"` gets a bubble with no outer chrome and no avatar column.
 */
describe('MessageBubble presentation seam', () => {
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
  });

  function render(props: Partial<React.ComponentProps<typeof MessageBubble>> = {}) {
    act(() => {
      root.render(
        <MessageBubble
          messageId="m-1"
          avatar={<span data-testid="avatar-column">av</span>}
          header={<div data-testid="header">head</div>}
          footer={<div data-testid="footer">foot</div>}
          bubbleRadius="rounded-2xl rounded-bl-sm"
          bubbleClassName="font-test"
          bubbleStyle={{ backgroundColor: 'rgb(1, 2, 3)', color: 'rgb(4, 5, 6)' }}
          wrapperClassName="group cat-persona-derived"
          {...props}
        >
          <p data-testid="body">hello</p>
        </MessageBubble>,
      );
    });
    const wrapper = container.querySelector('[data-message-id="m-1"]') as HTMLElement;
    const bubble = container.querySelector('[data-testid="message-bubble"]') as HTMLElement;
    return { wrapper, bubble };
  }

  it('keeps the bubble exactly as it was when no presentation is asked for', () => {
    const { wrapper, bubble } = render();

    // Pinned byte for byte, including the empty `justify-end` slot's double space the primitive has always emitted.
    expect(wrapper.className).toBe('flex gap-2 mb-4 items-start  group cat-persona-derived');
    expect(container.querySelector('[data-testid="avatar-column"]')).not.toBeNull();
    // The avatar column comes first, then the content column.
    expect(wrapper.firstElementChild?.getAttribute('data-testid')).toBe('avatar-column');
    expect(wrapper.children[1]?.className).toBe('max-w-[85%] md:max-w-[75%] min-w-0');
    expect(bubble.className).toBe(
      'px-4 py-3 transition-transform hover:-translate-y-0.5 overflow-hidden rounded-2xl rounded-bl-sm font-test',
    );
    expect(bubble.style.backgroundColor).toBe('rgb(1, 2, 3)');
  });

  it('treats an explicit bubble presentation the same as the default', () => {
    const { bubble: explicit } = render({ presentation: 'bubble' });
    const explicitClass = explicit.className;
    act(() => root.unmount());
    root = createRoot(container);
    const { bubble: implicit } = render();

    expect(explicitClass).toBe(implicit.className);
  });

  it('drops the avatar column and the bubble chrome for the nameplate presentation, and keeps the structure around the body', () => {
    const { wrapper, bubble } = render({ presentation: 'nameplate' });

    // The identity moves into the header's plate: no separate avatar column.
    expect(container.querySelector('[data-testid="avatar-column"]')).toBeNull();
    // DOM targets other code finds the message by stay where they were.
    expect(wrapper.getAttribute('data-message-id')).toBe('m-1');
    expect(wrapper.className).toContain('group');
    expect(wrapper.className).toContain('cat-persona-derived');
    expect(bubble).not.toBeNull();
    expect(bubble.contains(container.querySelector('[data-testid="body"]'))).toBe(true);

    // No frame: no padding, no radius, no hover lift, no clipping of what sits inside.
    for (const chrome of [
      'px-4',
      'py-3',
      'rounded-2xl',
      'rounded-bl-sm',
      'hover:-translate-y-0.5',
      'overflow-hidden',
    ]) {
      expect(bubble.className.split(/\s+/)).not.toContain(chrome);
    }
    // What the caller asked for on the body is still applied (breed font, text colour); the frame is not the caller's to keep.
    expect(bubble.className).toContain('font-test');
    expect(bubble.style.color).toBe('rgb(4, 5, 6)');
  });

  it('keeps header above and footer below the body, and lets the body reach the reading column edge', () => {
    const { wrapper } = render({ presentation: 'nameplate' });
    const column = wrapper.firstElementChild as HTMLElement;

    expect(column.className.split(/\s+/)).toContain('max-w-full');
    expect(column.className.split(/\s+/)).toContain('min-w-0');
    expect(Array.from(column.children).map((el) => el.getAttribute('data-testid'))).toEqual([
      'header',
      'message-bubble',
      'footer',
    ]);
  });

  it('lets a caller keep a narrower column for the nameplate presentation', () => {
    const { wrapper } = render({ presentation: 'nameplate', maxWidth: 'max-w-[86%]' });
    expect((wrapper.firstElementChild as HTMLElement).className).toContain('max-w-[86%]');
  });
});
