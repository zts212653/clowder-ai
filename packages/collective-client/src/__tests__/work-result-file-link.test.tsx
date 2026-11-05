// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageMarkdown } from '../MessageMarkdown.js';
import { CollectiveArtifactContext, type CollectiveArtifactState } from '../use-collective-artifacts.js';
import { SESSION_KEY } from '../use-human-auth-session.js';

describe('Collective Work result file links', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('promotes a same-Service result into the existing SharedArtifact surface instead of opening or downloading a Blob', async () => {
    const href = `${location.origin}/api/collaboration/work-result-files/wrf_${'a'.repeat(64)}/result.md`;
    const openWorkResultFile = vi.fn(async () => undefined);
    const openWindow = vi.spyOn(window, 'open');
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await act(async () => {
      root.render(
        <CollectiveArtifactContext.Provider value={{ openWorkResultFile } as unknown as CollectiveArtifactState}>
          <MessageMarkdown source={`[打开结果](${href})`} />
        </CollectiveArtifactContext.Provider>,
      );
    });
    const action = container.querySelector('button[data-collective-work-result-file]');
    expect(action).not.toBeNull();
    expect(container.querySelector(`a[href="${href}"]`)).toBeNull();
    expect(container.innerHTML).not.toContain('member-session-token');

    await act(async () => {
      action?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
      await Promise.resolve();
    });

    expect(openWorkResultFile).toHaveBeenCalledWith({
      fileId: `wrf_${'a'.repeat(64)}`,
      fileName: 'result.md',
      pathname: `/api/collaboration/work-result-files/wrf_${'a'.repeat(64)}/result.md`,
    });
    expect(openWindow).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses only the canonical file identity from an origin alias and never navigates or sends credentials there', async () => {
    const href = `https://files.example/api/collaboration/work-result-files/wrf_${'b'.repeat(64)}/result.md`;
    const openWorkResultFile = vi.fn(async () => undefined);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await act(async () => {
      root.render(
        <CollectiveArtifactContext.Provider value={{ openWorkResultFile } as unknown as CollectiveArtifactState}>
          <MessageMarkdown source={`[外部链接](${href})`} />
        </CollectiveArtifactContext.Provider>,
      );
    });
    const action = container.querySelector('button[data-collective-work-result-file]');
    expect(action).not.toBeNull();
    expect(container.querySelector(`a[href="${href}"]`)).toBeNull();
    await act(async () => {
      action?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(openWorkResultFile).toHaveBeenCalledWith({
      fileId: `wrf_${'b'.repeat(64)}`,
      fileName: 'result.md',
      pathname: `/api/collaboration/work-result-files/wrf_${'b'.repeat(64)}/result.md`,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the original Markdown result intact when the SharedArtifact provider is unavailable', async () => {
    const href = `${location.origin}/api/collaboration/work-result-files/wrf_${'d'.repeat(64)}/result.md`;
    const openWindow = vi.spyOn(window, 'open');
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await act(async () => {
      root.render(<MessageMarkdown source={`[Open result](${href})`} />);
    });
    await act(async () => {
      container
        .querySelector('button[data-collective-work-result-file]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain('结果作品暂时无法打开；原结果仍已保留，可以稍后重试。');
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(openWindow).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a plain-text result on the authenticated current-Service read path instead of sending it to Markdown promotion', async () => {
    const href = `https://files.example/api/collaboration/work-result-files/wrf_${'c'.repeat(64)}/result.txt`;
    sessionStorage.setItem(`${SESSION_KEY}:${location.origin}`, 'member-session-token');
    const fetchResult = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain; charset=utf-8' }),
      blob: vi.fn().mockResolvedValue(new Blob(['exact plain result'], { type: 'text/plain' })),
    };
    const fetchMock = vi.fn().mockResolvedValue(fetchResult);
    vi.stubGlobal('fetch', fetchMock);
    const popup = { opener: window, location: { replace: vi.fn() }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn().mockReturnValue('blob:collective-plain-result'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const openWorkResultFile = vi.fn(async () => undefined);

    await act(async () => {
      root.render(
        <CollectiveArtifactContext.Provider value={{ openWorkResultFile } as unknown as CollectiveArtifactState}>
          <MessageMarkdown source={`[Open text result](${href})`} />
        </CollectiveArtifactContext.Provider>,
      );
    });
    await act(async () => {
      container
        .querySelector('button[data-collective-work-result-file]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(openWorkResultFile).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      `${location.origin}/api/collaboration/work-result-files/wrf_${'c'.repeat(64)}/result.txt`,
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { authorization: 'Bearer member-session-token' },
      }),
    );
    expect(popup.location.replace).toHaveBeenCalledWith('blob:collective-plain-result');
  });
});
