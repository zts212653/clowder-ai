import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const catRegistry = vi.hoisted(() => ({
  current: null as null | {
    id: string;
    displayName: string;
    avatar: string;
    color: { primary: string; secondary: string };
  },
}));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: () => catRegistry.current,
    cats: catRegistry.current ? [catRegistry.current] : [],
    refresh: () => {},
  }),
}));

import { CatAvatar } from '../CatAvatar';

let container: HTMLElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

beforeEach(() => {
  catRegistry.current = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('CatAvatar registry hydration race', () => {
  it('retries with the canonical uploaded avatar after the provisional path fails', async () => {
    await act(async () => {
      root.render(<CatAvatar catId="codex-sol" size={32} />);
    });

    const provisional = container.querySelector('img');
    expect(provisional?.getAttribute('src')).toBe('/avatars/codex-sol.png');

    await act(async () => {
      provisional?.dispatchEvent(new Event('error'));
    });
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('🐾');

    catRegistry.current = {
      id: 'codex-sol',
      displayName: '小太阳·砚砚',
      avatar: '/uploads/avatar-codex-sol.png',
      color: { primary: '#237A57', secondary: '#DCEFE7' },
    };
    await act(async () => {
      root.render(<CatAvatar catId="codex-sol" size={32} />);
    });

    expect(container.querySelector('img')?.getAttribute('src')).toBe('/uploads/avatar-codex-sol.png');
    expect(container.textContent).not.toContain('🐾');
  });
});
