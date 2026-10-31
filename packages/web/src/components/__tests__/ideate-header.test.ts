import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IdeateHeader } from '../IdeateHeader';

describe('IdeateHeader', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('explains independent sampling without duplicating execution controls or usage', () => {
    act(() => root.render(React.createElement(IdeateHeader)));

    expect(container.textContent).toContain('独立观点采样');
    expect(container.textContent).toContain('本轮各成员独立思考并分别回答，彼此不会互相触发');
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).not.toContain('Cost');
    expect(container.textContent).not.toContain('In:');
    expect(container.textContent).not.toContain('Out:');
  });
});
