import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MessageBubble } from '../MessageBubble';

/**
 * F322 B segment 1 (human message) — the explicit seam for the new presentation of your own message.
 * DESIGN.md「对话」: right-aligned, one whole block with 12px corners, no avatar, no signature, at most about eighty
 * percent of the reading column, the text left-aligned inside it. The shared primitive's default must stay what it was.
 */
describe('MessageBubble human presentation', () => {
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
          messageId="h-1"
          align="right"
          avatar={<span data-testid="avatar-column">me</span>}
          header={<div data-testid="header">head</div>}
          footer={<div data-testid="footer">foot</div>}
          bubbleRadius="rounded-2xl rounded-br-sm"
          bubbleClassName="extra-class"
          bubbleStyle={{ backgroundColor: 'rgb(1, 2, 3)', color: 'rgb(4, 5, 6)' }}
          wrapperClassName="group cat-persona-derived"
          {...props}
        >
          <p data-testid="body">hello</p>
        </MessageBubble>,
      );
    });
    return {
      wrapper: container.querySelector('[data-message-id="h-1"]') as HTMLElement,
      bubble: container.querySelector('[data-testid="message-bubble"]') as HTMLElement,
    };
  }

  it('keeps the right-aligned bubble with its avatar exactly as it was when no presentation is asked for', () => {
    const { wrapper, bubble } = render();

    expect(wrapper.className).toBe('flex gap-2 mb-4 items-start justify-end group cat-persona-derived');
    expect(wrapper.lastElementChild?.getAttribute('data-testid')).toBe('avatar-column');
    expect(wrapper.firstElementChild?.className).toBe('max-w-[75%] min-w-0');
    expect(bubble.className).toBe(
      'px-4 py-3 transition-transform hover:-translate-y-0.5 overflow-hidden rounded-2xl rounded-br-sm extra-class',
    );
  });

  it('draws no avatar and no corner tail in the human presentation, and keeps the structure around the body', () => {
    const { wrapper, bubble } = render({ presentation: 'human' });

    expect(container.querySelector('[data-testid="avatar-column"]')).toBeNull();
    expect(wrapper.getAttribute('data-message-id')).toBe('h-1');
    expect(wrapper.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['flex', 'justify-end', 'group', 'cat-persona-derived']),
    );
    expect(bubble.contains(container.querySelector('[data-testid="body"]'))).toBe(true);
    const column = wrapper.firstElementChild as HTMLElement;
    expect(Array.from(column.children).map((el) => el.getAttribute('data-testid'))).toEqual([
      'header',
      'message-bubble',
      'footer',
    ]);
  });

  it("is one whole 12px block: all four corners the same, the text left-aligned, the fill and text colour the caller's", () => {
    const { bubble } = render({ presentation: 'human' });
    const classes = bubble.className.split(/\s+/);

    expect(classes).toContain('rounded-xl');
    expect(classes).toContain('text-left');
    expect(classes).toContain('extra-class');
    // The old tail corner and the caller's radius are not applied: the corners are not a per-message choice here.
    expect(bubble.className).not.toContain('rounded-br-sm');
    expect(bubble.className).not.toContain('rounded-2xl');
    expect(bubble.style.backgroundColor).toBe('rgb(1, 2, 3)');
    expect(bubble.style.color).toBe('rgb(4, 5, 6)');
    // A real frame, so content that is wider than the block is still clipped to its corners; no hover lift.
    expect(classes).toContain('overflow-hidden');
    expect(classes).not.toContain('hover:-translate-y-0.5');
    expect(classes).not.toContain('transition-transform');
  });

  it('hugs a short message and stops at about eighty percent of the reading column, with the blank on the left', () => {
    const { wrapper } = render({ presentation: 'human' });
    const column = wrapper.firstElementChild as HTMLElement;
    const classes = column.className.split(/\s+/);

    expect(classes).toContain('max-w-[80%]');
    expect(classes).toContain('min-w-0');
    expect(classes).toContain('flex');
    expect(classes).toContain('flex-col');
    expect(classes).toContain('items-end');
  });

  it('lets the caller keep a narrower column', () => {
    const { wrapper } = render({ presentation: 'human', maxWidth: 'max-w-[86%]' });
    const column = wrapper.firstElementChild as HTMLElement;

    expect(column.className).toContain('max-w-[86%]');
    expect(column.className).not.toContain('max-w-[80%]');
  });
});
