import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useCatData', () => {
  const cat = {
    id: 'opus',
    displayName: '布偶猫',
    avatar: '/avatars/opus.png',
    color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
  };
  return { useCatData: () => ({ getCatById: () => cat, cats: [cat], refresh: () => {} }) };
});

import { CatAvatar } from '../CatAvatar';

/**
 * F322 B segment 1 — the nameplate is already the cat's colour, so the avatar in it carries no ring of its own
 * (design owner, 2026-10-01). The prop is optional and the default is the ring every other avatar has always had.
 */
describe('CatAvatar ring', () => {
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

  const face = () => container.querySelector('img')?.parentElement as HTMLElement;
  const classes = () => face().className.split(/\s+/);

  it('keeps the cat-coloured ring by default', () => {
    act(() => root.render(<CatAvatar catId="opus" size={32} />));

    expect(classes()).toContain('ring-2');
    expect(face().style.getPropertyValue('--tw-ring-color')).toBe('#9B7EBD');
  });

  it('treats an explicit cat ring the same as the default', () => {
    act(() => root.render(<CatAvatar catId="opus" size={32} ring="cat" />));

    expect(classes()).toContain('ring-2');
    expect(face().style.getPropertyValue('--tw-ring-color')).toBe('#9B7EBD');
  });

  it('draws no ring when asked for none, and the face keeps its size and image', () => {
    act(() => root.render(<CatAvatar catId="opus" size={16} ring="none" />));

    expect(classes()).not.toContain('ring-2');
    expect(face().style.getPropertyValue('--tw-ring-color')).toBe('');
    expect(face().style.width).toBe('16px');
    expect(container.querySelector('img')?.getAttribute('width')).toBe('16');
  });

  it('still shows a failed state with no ring requested: an error is not decoration', () => {
    act(() => root.render(<CatAvatar catId="opus" size={16} ring="none" status="error" />));

    expect(classes()).toContain('ring-2');
    expect(face().style.getPropertyValue('--tw-ring-color')).toBe('var(--semantic-critical)');
  });

  it('keeps streaming visible without a ring: the pulse stays', () => {
    act(() => root.render(<CatAvatar catId="opus" size={16} ring="none" status="streaming" />));

    expect(classes()).not.toContain('ring-2');
    expect(classes()).toContain('animate-pulse');
  });

  it('keeps the hover ring reachable while streaming: the glow is composed with the ring variables, not written over them', () => {
    act(() =>
      root.render(<CatAvatar catId="opus" size={16} ring="none" status="streaming" onClick={() => undefined} />),
    );
    const button = container.querySelector('button') as HTMLButtonElement;

    // An inline box-shadow replaces the whole shadow stack, including the one hover:ring-2 sets through these variables.
    expect(button.style.boxShadow).toContain('var(--tw-ring-offset-shadow');
    expect(button.style.boxShadow).toContain('var(--tw-ring-shadow');
    expect(button.style.boxShadow).toContain('0 0 10px');
  });

  it('leaves the default streaming avatar exactly as it was: glow only', () => {
    act(() => root.render(<CatAvatar catId="opus" size={32} status="streaming" onClick={() => undefined} />));
    const button = container.querySelector('button') as HTMLButtonElement;

    expect(button.style.boxShadow).not.toContain('--tw-ring');
    expect(button.style.boxShadow).toContain('0 0 10px');
  });

  it('keeps a clickable avatar discoverable without a ring: the focus/hover ring appears only on interaction', () => {
    act(() => root.render(<CatAvatar catId="opus" size={16} ring="none" onClick={() => undefined} />));
    const button = container.querySelector('button') as HTMLButtonElement;

    expect(button.className.split(/\s+/)).not.toContain('ring-2');
    expect(button.className).toContain('hover:ring-2');
    expect(button.className).toContain('cursor-pointer');
  });
});
