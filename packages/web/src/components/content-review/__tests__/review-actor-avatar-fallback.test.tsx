/** F314-1: a review comment by the owner keeps its initial when the owner's avatar image cannot load. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useCoCreatorConfig', () => ({
  useCoCreatorConfig: () => ({ name: 'Riley', avatar: 'https://example.invalid/me.png' }),
}));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => undefined }) }));

import { ReviewActor } from '@/components/content-review/ReviewActor';

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function avatarSlot(): HTMLElement {
  const slot = container.querySelector<HTMLElement>('[data-actor-kind] > span');
  if (!slot) throw new Error('Missing avatar slot');
  return slot;
}

it('shows the owner initial instead of a broken image (F314-1)', async () => {
  const actor = { kind: 'human', actorId: 'owner-1' } as Parameters<typeof ReviewActor>[0]['actor'];
  await act(async () => root.render(<ReviewActor actor={actor} ownerUserId="owner-1" />));
  expect(avatarSlot().querySelector('img')?.getAttribute('src')).toBe('https://example.invalid/me.png');

  await act(async () => avatarSlot().querySelector('img')?.dispatchEvent(new Event('error')));
  expect(avatarSlot().querySelector('img')).toBeNull();
  expect(avatarSlot().textContent).toBe('R');
});

it('keeps the initial for a person other than the owner', async () => {
  const actor = { kind: 'human', actorId: 'friend-2' } as Parameters<typeof ReviewActor>[0]['actor'];
  await act(async () => root.render(<ReviewActor actor={actor} ownerUserId="owner-1" />));
  expect(avatarSlot().querySelector('img')).toBeNull();
  expect(avatarSlot().textContent).toBe('f');
});
