import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useThreadDisplayInfo', () => ({
  useThreadDisplayInfo: (id: string) => ({
    currentThread: { id, title: id, projectPath: '/p', preferredCats: [], labels: [] },
  }),
}));

import { writeShellPresentation } from '../shell/shell-presentation';
import { ThreadSettingsButton } from '../shell/ThreadSettingsButton';
import { ThreadSettingsProvider } from '../ThreadSidebar/ThreadSettingsProvider';

const panel = () => document.querySelector('[data-testid="thread-settings-panel"]');

describe('Conversation settings header toggle', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    writeShellPresentation('v2');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    writeShellPresentation('classic');
    vi.unstubAllGlobals();
  });

  async function press(el: Element) {
    // a real mouse press: mousedown -> mouseup -> click
    await act(async () => {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      (el as HTMLElement).click();
    });
  }

  it('second press on ⋯ closes the panel (the retired menu toggled)', async () => {
    await act(async () =>
      root.render(
        <ThreadSettingsProvider routeThreadId="t1">
          <ThreadSettingsButton threadId="t1" />
        </ThreadSettingsProvider>,
      ),
    );
    const button = container.querySelector('button[aria-label="对话设置"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await press(button);
    expect(panel()).not.toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(panel()?.id);
    await press(button);
    expect(panel()).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await press(button);
    expect(panel()).not.toBeNull();
    await act(async () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(panel()).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });
});
