/**
 * PR #1663: SectionGroup path tooltip behavior for short same-name projects
 *
 * Verifies that real project paths (e.g., C:\team-a\demo and D:\team-b\demo)
 * show full path tooltips on hover/focus regardless of name truncation, while
 * virtual/default sections only show tooltips when actually truncated.
 *
 * Related: https://github.com/zts212653/clowder-ai/pull/1663#discussion_r4337751217
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_TOOLTIP_CONTENT_DELAY_MS, resetAppTooltipWarmState } from '../AppTooltip';
import { SectionGroup } from '../ThreadSidebar/SectionGroup';

const paths = ['C:\\team-a\\demo', 'D:\\team-b\\demo'];

function pointer(element: Element, type: 'pointerover' | 'pointerout') {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  if (type === 'pointerout') Object.defineProperty(event, 'relatedTarget', { value: document.body });
  act(() => element.dispatchEvent(event));
}

function tip() {
  return document.body.querySelector('[role="tooltip"]');
}

describe('SectionGroup: real short project paths remain recoverable (#1663)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    resetAppTooltipWarmState();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetAppTooltipWarmState();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function renderProjects(projectPaths: (string | undefined)[] = paths) {
    act(() =>
      root.render(
        <>
          {projectPaths.map((projectPath, index) => (
            <SectionGroup
              key={index}
              label="demo"
              count={0}
              isCollapsed={false}
              onToggle={() => {}}
              projectPath={projectPath}
            >
              {null}
            </SectionGroup>
          ))}
        </>,
      ),
    );

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label="demo"]'));
    for (const button of buttons) {
      // Simulate non-truncated state: clientWidth === scrollWidth
      for (const node of [button, ...button.querySelectorAll('.truncate')]) {
        Object.defineProperties(node, {
          clientWidth: { value: 100, configurable: true },
          scrollWidth: { value: 100, configurable: true },
          clientHeight: { value: 20, configurable: true },
          scrollHeight: { value: 20, configurable: true },
        });
      }
      expect(button.textContent).toBe('demo');
      expect(button.getAttribute('title')).toBeNull();
    }
    return buttons;
  }

  function keyboardFocus(button: HTMLButtonElement) {
    const originalMatches = Element.prototype.matches;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      return selector === ':focus-visible' ? true : originalMatches.call(this, selector);
    });
    act(() => button.focus());
  }

  it.each([0, 1])('hover restores the correct untruncated path at index %i', (index) => {
    const buttons = renderProjects();

    pointer(buttons[index], 'pointerover');

    // Wait for APP_TOOLTIP_CONTENT_DELAY_MS (600ms for intent="content")
    act(() => vi.advanceTimersByTime(APP_TOOLTIP_CONTENT_DELAY_MS - 1));
    expect(tip()).toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(tip()).not.toBeNull();
    expect(tip()?.textContent).toContain(paths[index]);
    expect(tip()?.textContent).not.toContain(paths[1 - index]);

    // Escape dismisses tooltip
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(tip()).toBeNull();
  });

  it.each([0, 1])('keyboard focus restores the correct untruncated path at index %i', (index) => {
    const buttons = renderProjects();

    keyboardFocus(buttons[index]);

    // Keyboard focus should show tooltip immediately
    expect(tip()).not.toBeNull();
    expect(tip()?.textContent).toContain(paths[index]);
    expect(tip()?.textContent).not.toContain(paths[1 - index]);
  });

  it.each([undefined, 'default'])('short virtual section %s keeps truncation-only hints', (projectPath) => {
    const [button] = renderProjects([projectPath]);

    // Hover should not show tooltip for virtual/default sections when not truncated
    pointer(button, 'pointerover');
    act(() => vi.advanceTimersByTime(APP_TOOLTIP_CONTENT_DELAY_MS));
    expect(tip()).toBeNull();

    pointer(button, 'pointerout');

    // Focus should also not show tooltip
    keyboardFocus(button);
    expect(tip()).toBeNull();
  });
});
