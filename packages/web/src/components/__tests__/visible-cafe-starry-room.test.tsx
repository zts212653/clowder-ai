import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { StarryRoom } from '@/components/visible-cafe/StarryRoom';
import type { SkinManifest } from '@/lib/visible-cafe/asset-config';
import { createInitialSnapshot } from '@/lib/visible-cafe/presence-types';
import { useVisibleCafePresenceStore } from '@/stores/visible-cafe-presence';

vi.mock('@/components/visible-cafe/CatSprite', () => ({
  CatSprite: () => <div data-testid="cat-sprite" />,
  isQuietHours: () => false,
}));
vi.mock('@/components/visible-cafe/ProvenanceOverlay', () => ({ ProvenanceOverlay: () => null }));
vi.mock('@/components/visible-cafe/StarCard', () => ({
  StarCard: ({ card }: { card: { title: string } }) => <section data-testid="star-card">{card.title}</section>,
}));

const skin: SkinManifest = {
  id: 'xianxian',
  displayName: '宪宪',
  version: 1,
  format: 'atlas-row',
  cell: { width: 32, height: 32 },
  rows: {},
};

describe('F258 StarryRoom scene anchoring', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useVisibleCafePresenceStore.setState({
      snapshot: createInitialSnapshot(),
      starLights: [{ threadId: 'thread-one', brightness: 1, x: 0.5, y: 0.5 }],
      threadMetas: new Map([
        [
          'thread-one',
          {
            threadId: 'thread-one',
            title: '平行世界的宪宪',
            participants: ['fable5'],
            preferredCats: ['fable5'],
            lastActiveAt: Date.now(),
          },
        ],
      ]),
      selectedStarThreadId: null,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    React.act(() => root.unmount());
    container.remove();
    useVisibleCafePresenceStore.getState().reset();
  });

  it('anchors stars to the contained scene window and opens the selected thread card', () => {
    React.act(() => root.render(<StarryRoom skin={skin} />));

    expect(container.querySelector('[data-testid="main-planet-stage"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="star-window-anchor"]')).toBeTruthy();

    const star = container.querySelector<HTMLButtonElement>('button[aria-label^="打开猫猫星球"]');
    expect(star).toBeTruthy();
    React.act(() => star?.click());

    expect(container.querySelector('[data-testid="star-card"]')?.textContent).toBe('平行世界的宪宪');
  });
});
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = undefined;
});
