import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '../../shell/shell-language';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { HelpTip } from '../HelpTip';
import { SystemSettingsView } from '../SystemSettingsView';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  writeShellPresentation('v2');
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  writeShellLanguage('zh');
  writeShellPresentation('classic');
  vi.unstubAllGlobals();
});

it.each([
  'zh',
  'en',
] as const)('opens the real setting explanation by focus and click, then dismisses in %s', (language) => {
  writeShellLanguage(language);
  act(() =>
    root.render(
      <SystemSettingsView
        groupLabels={{ storage: 'Storage' }}
        variables={[
          {
            name: 'DATA_DIR',
            label: 'Storage',
            description: 'The real configured storage directory.',
            category: 'system',
            settingsGroup: 'storage',
            sensitive: false,
            currentValue: '/actual/data',
            defaultValue: '/default/data',
          },
        ]}
      />,
    ),
  );
  const button = host.querySelector<HTMLButtonElement>('button');
  expect(button).not.toBeNull();
  expect(button?.getAttribute('aria-label')).toBe(language === 'zh' ? '关于Storage' : 'About Storage');
  act(() => button!.focus());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('The real configured storage directory.');
  expect(host.textContent).toContain('/actual/data');
  act(() => button!.click());
  expect(button?.getAttribute('aria-expanded')).toBe('true');
  act(() => button!.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  act(() => button!.click());
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(button);
});

it('lets a mouse enter the explanation across the gap, then closes it outside', () => {
  vi.useFakeTimers();
  try {
    act(() => root.render(<HelpTip topic="Storage">Readable explanation</HelpTip>));
    const owner = host.querySelector('span');
    function pointer(target: Element, type: string, relatedTarget: EventTarget | null = null) {
      const event = new MouseEvent(type, { bubbles: true, relatedTarget });
      Object.defineProperty(event, 'pointerType', { value: 'mouse' });
      act(() => target.dispatchEvent(event));
    }
    pointer(owner!, 'pointerover');
    act(() => vi.advanceTimersByTime(150));
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    pointer(owner!, 'pointerout', document.body);
    pointer(dialog!, 'pointerover', document.body);
    act(() => vi.advanceTimersByTime(150));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    pointer(document.body, 'pointerdown');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
