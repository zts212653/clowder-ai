import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { StarryRoom } from '@/components/visible-cafe/StarryRoom';
import type { SkinManifest } from '@/lib/visible-cafe/asset-config';

vi.mock('@/components/visible-cafe/CatSprite', () => ({
  isQuietHours: () => false,
  CatSprite: ({ onClick }: { onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      cat-sprite-test
    </button>
  ),
}));

vi.mock('@/components/visible-cafe/StarWindow', () => ({ StarWindow: () => <div>star-window-test</div> }));
vi.mock('@/components/visible-cafe/StarCard', () => ({ StarCard: () => <div>star-card-test</div> }));
vi.mock('@/components/visible-cafe/ProvenanceOverlay', () => ({
  ProvenanceOverlay: () => <div>source-chain-test</div>,
}));

const skin: SkinManifest = {
  id: 'test',
  displayName: '宪宪',
  version: 1,
  format: 'row-strip',
  cell: { width: 192, height: 208 },
  rows: {
    idle: { src: 'idle.png', frames: 1, frameDurations: [500], anchorOffsetY: 0 },
    sleeping: { src: 'sleep.png', frames: 1, frameDurations: [500], anchorOffsetY: 0 },
  },
};

describe('F255 entry inside the F258 room', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as Record<string, unknown>).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).React;
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

  it('opens the adjacent cat-home boundary while keeping provenance independently reachable', () => {
    const openHome = vi.fn();
    act(() => root.render(<StarryRoom skin={skin} onCatHomeOpen={openHome} />));

    const sprite = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('cat-sprite-test'),
    );
    if (!sprite) throw new Error('cat sprite entry was not found');
    act(() => sprite.click());
    expect(openHome).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain('source-chain-test');

    const provenance = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('状态来源'),
    );
    if (!provenance) throw new Error('provenance entry was not found');
    act(() => provenance.click());
    expect(container.textContent).toContain('source-chain-test');
  });
});
