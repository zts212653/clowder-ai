import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useMemberReturn } from '../useMemberReturn';

it('restores the precise member and scroll after the list is revealed on the next frame', () => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let nextFrame: FrameRequestCallback | undefined;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    nextFrame = callback;
    return 1;
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  function Scene() {
    const location = useMemberReturn();
    return (
      <div data-trajectory-origin-scroll>
        <div ref={location.host}>
          <button type="button" onClick={location.remember}>
            Member A
          </button>
        </div>
        <button type="button" onClick={location.restore}>
          Return
        </button>
      </div>
    );
  }
  try {
    act(() => root.render(<Scene />));
    const [member, back] = container.querySelectorAll('button');
    const scroll = container.querySelector<HTMLElement>('[data-trajectory-origin-scroll]');
    if (!scroll || !member || !back) throw Error('fixture');
    scroll.scrollTop = 120;
    member.focus();
    act(() => member.click());
    expect(scroll.scrollTop).toBe(0);
    back.focus();
    act(() => back.click());
    expect(document.activeElement).toBe(back);
    act(() => nextFrame?.(0));
    expect(document.activeElement).toBe(member);
    expect(scroll.scrollTop).toBe(120);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
