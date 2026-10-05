import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionIdTag } from '../SessionChainInputs';

let container: HTMLDivElement;
let root: Root;
let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  (globalThis as { React?: typeof React }).React = React;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('direct identifier copy', () => {
  it('does not label a replacement identifier as already copied', async () => {
    act(() => root.render(<SessionIdTag id="previous-session" />));
    await act(async () => container.querySelector('button')?.click());
    expect(container.textContent).toContain('已复制');
    act(() => root.render(<SessionIdTag id="new-complete-session" />));
    expect(container.textContent).not.toContain('已复制');
    await act(async () => container.querySelector('button')?.click());
    expect(writeText).toHaveBeenLastCalledWith('new-complete-session');
  });
  it('copies the complete long value and reports success in Chinese', async () => {
    const id = 'cli-session-full-value-that-is-longer-than-a-narrow-workspace';
    act(() => root.render(React.createElement(SessionIdTag, { id })));
    const button = container.querySelector('button');
    expect(button?.textContent).toBe(id);
    await act(async () => button?.click());
    expect(writeText).toHaveBeenCalledWith(id);
    expect(container.textContent).toContain('已复制');
    expect(button?.getAttribute('aria-label')).toContain(id);
  });

  it('reports a rejected clipboard request and permits a successful retry', async () => {
    writeText.mockRejectedValueOnce(new Error('clipboard unavailable'));
    act(() => root.render(React.createElement(SessionIdTag, { id: 'exact-session-id' })));
    const button = container.querySelector('button');
    await act(async () => button?.click());
    expect(container.textContent).toContain('复制失败');
    await act(async () => button?.click());
    expect(writeText).toHaveBeenLastCalledWith('exact-session-id');
    expect(container.textContent).toContain('已复制');
  });
});
