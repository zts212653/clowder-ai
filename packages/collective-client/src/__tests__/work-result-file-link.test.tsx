// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageMarkdown } from '../MessageMarkdown.js';
import { SESSION_KEY } from '../use-human-auth-session.js';

describe('Collective Work result file links', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    sessionStorage.setItem(`${SESSION_KEY}:${location.origin}`, 'member-session-token');
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    sessionStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens a same-Service result file only through the authenticated action instead of exposing a navigable API href', async () => {
    const href = `${location.origin}/api/collaboration/work-result-files/wrf_${'a'.repeat(64)}/result.md`;
    const fetchResult = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/markdown; charset=utf-8' }),
      blob: vi.fn().mockResolvedValue(new Blob(['# exact result'], { type: 'text/markdown' })),
    };
    const fetchMock = vi.fn().mockResolvedValue(fetchResult);
    vi.stubGlobal('fetch', fetchMock);
    const popup = { opener: window, location: { replace: vi.fn() }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn().mockReturnValue('blob:collective-result'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });

    await act(async () => {
      root.render(<MessageMarkdown source={`[打开结果](${href})`} />);
    });
    const action = container.querySelector('button[data-collective-work-result-file]');
    expect(action).not.toBeNull();
    expect(container.querySelector(`a[href="${href}"]`)).toBeNull();
    expect(container.innerHTML).not.toContain('member-session-token');

    await act(async () => {
      action?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      href,
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { authorization: 'Bearer member-session-token' },
      }),
    );
    expect(popup.location.replace).toHaveBeenCalledWith('blob:collective-result');
  });

  it('normalizes a canonical file path to the current Service and never sends the Human bearer to an origin alias', async () => {
    const href = `https://files.example/api/collaboration/work-result-files/wrf_${'b'.repeat(64)}/result.md`;
    const fetchResult = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/markdown; charset=utf-8' }),
      blob: vi.fn().mockResolvedValue(new Blob(['# exact result'], { type: 'text/markdown' })),
    };
    const fetchMock = vi.fn().mockResolvedValue(fetchResult);
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window, 'open').mockReturnValue(null);
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn().mockReturnValue('blob:collective-result'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });

    await act(async () => {
      root.render(<MessageMarkdown source={`[外部链接](${href})`} />);
    });
    const action = container.querySelector('button[data-collective-work-result-file]');
    expect(action).not.toBeNull();
    expect(container.querySelector(`a[href="${href}"]`)).toBeNull();
    await act(async () => {
      action?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `${location.origin}/api/collaboration/work-result-files/wrf_${'b'.repeat(64)}/result.md`,
      expect.objectContaining({
        cache: 'no-store',
        headers: { authorization: 'Bearer member-session-token' },
      }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(href, expect.anything());
  });
});
