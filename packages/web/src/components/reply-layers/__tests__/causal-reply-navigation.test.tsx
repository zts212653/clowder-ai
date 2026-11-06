import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageViewportBoundary } from '../../MessageViewportBoundary';
import { causalContinuationId, focusCausalContinuation } from '../CausalReplyContext';

describe('causal continuation navigation', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    vi.unstubAllGlobals();
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('mounts the actual deferred input owner before focusing its continuation', () => {
    act(() =>
      root.render(
        <MessageViewportBoundary messageId="S">
          <div data-message-id="S" />
          <div id={causalContinuationId('S', 'R')} tabIndex={-1}>
            接续正文
          </div>
        </MessageViewportBoundary>,
      ),
    );
    expect(document.getElementById(causalContinuationId('S', 'R'))).toBeNull();
    act(() => expect(focusCausalContinuation('S', 'R')).toBe(true));
    expect(document.activeElement?.id).toBe(causalContinuationId('S', 'R'));
    expect(host.querySelector('[data-deferred-message-id]')).toBeNull();
  });

  it('skips equal-cut empty continuations and mounts the next actual text', () => {
    act(() =>
      root.render(
        <>
          <div id={causalContinuationId('S', 'R')} data-causal-next-input="S2" tabIndex={-1} />
          <MessageViewportBoundary messageId="S2">
            <div data-message-id="S2" />
            <div id={causalContinuationId('S2', 'R')} tabIndex={-1}>
              实际接续正文
            </div>
          </MessageViewportBoundary>
        </>,
      ),
    );
    act(() => expect(focusCausalContinuation('S', 'R')).toBe(true));
    expect(document.activeElement?.id).toBe(causalContinuationId('S2', 'R'));
  });
});
