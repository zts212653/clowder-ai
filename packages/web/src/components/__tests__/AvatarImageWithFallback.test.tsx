import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AvatarImageWithFallback } from '@/components/AvatarImageWithFallback';

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function getImg(): HTMLImageElement {
  const img = container.querySelector('img');
  if (!img) throw new Error('Missing <img>');
  return img;
}

describe('AvatarImageWithFallback', () => {
  it('renders the provided src when not errored', async () => {
    await act(async () => {
      root.render(<AvatarImageWithFallback src="/avatars/opus-47.png" alt="Avatar" />);
    });
    expect(getImg().getAttribute('src')).toBe('/avatars/opus-47.png');
  });

  it('renders fallback when src is null', async () => {
    await act(async () => {
      root.render(<AvatarImageWithFallback src={null} alt="Avatar" />);
    });
    expect(getImg().getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
  });

  it('switches to fallback after onError fires', async () => {
    await act(async () => {
      root.render(<AvatarImageWithFallback src="/avatars/missing.png" alt="Avatar" />);
    });
    expect(getImg().getAttribute('src')).toBe('/avatars/missing.png');

    await act(async () => {
      getImg().dispatchEvent(new Event('error'));
    });
    expect(getImg().getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
  });
});
