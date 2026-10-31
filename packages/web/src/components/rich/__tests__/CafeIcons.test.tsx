import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CafeIcon, cafeIconNames } from '../CafeIcons';

Object.assign(globalThis as Record<string, unknown>, { React });

describe('CafeIcons — F225 SVG coverage to retire rich-block emoji', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
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

  it('exposes the system-semantic icons that replace card emoji (📥 📌 ☑ ☐)', () => {
    // inbox ← 📥 (propose-thread title), pin ← 📌 (pin-on-approve),
    // square / check-square ← ☐ / ☑ (checklist items)
    for (const name of ['inbox', 'pin', 'square', 'check-square', 'megaphone']) {
      expect(cafeIconNames).toContain(name);
    }
  });

  it('renders an <svg> with a <path> for a known icon', () => {
    act(() => root.render(<CafeIcon name="inbox" />));
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('path')).not.toBeNull();
  });

  it('renders nothing for an unknown icon name (graceful fallback)', () => {
    act(() => root.render(<CafeIcon name="does-not-exist-xyz" />));
    expect(container.querySelector('svg')).toBeNull();
  });
});
