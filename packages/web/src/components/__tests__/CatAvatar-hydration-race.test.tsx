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
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://127.0.0.1:3102' }));

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
  it('opens a canonical avatar at the API origin when the frontend uses another port', async () => {
    catRegistry.current = {
      id: 'canon-member',
      displayName: '正典成员',
      avatar: '/api/cats/canon-member/avatar?bindingRevision=1',
      color: { primary: '#237A57', secondary: '#DCEFE7' },
    };
    await act(async () => root.render(<CatAvatar catId="canon-member" />));
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'http://127.0.0.1:3102/api/cats/canon-member/avatar?bindingRevision=1',
    );
  });

  it('reports a broken canonical original and tries a newly selected binding without substituting another avatar', async () => {
    catRegistry.current = {
      id: 'canon-member',
      displayName: '正典成员',
      avatar: '/api/cats/canon-member/avatar?bindingRevision=1',
      color: { primary: '#237A57', secondary: '#DCEFE7' },
    };
    await act(async () => root.render(<CatAvatar catId="canon-member" />));
    await act(async () => container.querySelector('img')?.dispatchEvent(new Event('error')));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[aria-label="这张图打不开了"]')).not.toBeNull();
    expect(container.textContent).not.toContain('🐾');
    catRegistry.current.avatar = '/api/cats/canon-member/avatar?bindingRevision=2';
    await act(async () => root.render(<CatAvatar catId="canon-member" />));
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'http://127.0.0.1:3102/api/cats/canon-member/avatar?bindingRevision=2',
    );
  });

  it('does not request an invented asset for a new partner while its registry entry loads', async () => {
    await act(async () => root.render(<CatAvatar catId="pi" size={32} />));
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/avatars/default.png');
    catRegistry.current = {
      id: 'pi',
      displayName: '派派',
      avatar: '/avatars/family/opencode.png',
      color: { primary: '#237A57', secondary: '#DCEFE7' },
    };
    await act(async () => root.render(<CatAvatar catId="pi" size={32} />));
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/avatars/family/opencode.png');
  });

  it('retries with the canonical uploaded avatar after the provisional path fails', async () => {
    await act(async () => {
      root.render(<CatAvatar catId="codex-sol" size={32} />);
    });

    const provisional = container.querySelector('img');
    expect(provisional?.getAttribute('src')).toBe('/avatars/default.png');

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
