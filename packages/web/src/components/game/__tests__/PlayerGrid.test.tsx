import type { SeatView } from '@cat-cafe/shared';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PlayerGrid } from '../PlayerGrid';

Object.assign(globalThis as Record<string, unknown>, { React });

const mockSeats: SeatView[] = [
  { seatId: 'P1', actorType: 'human', actorId: 'coCreator', displayName: '铲屎官', alive: true },
  { seatId: 'P2', actorType: 'cat', actorId: 'opus', displayName: '宪宪', alive: true },
  { seatId: 'P3', actorType: 'cat', actorId: 'codex', displayName: '砚砚', alive: true },
  { seatId: 'P6', actorType: 'cat', actorId: 'dare', displayName: 'Dare', alive: false },
];

function render(props: Partial<Parameters<typeof PlayerGrid>[0]> = {}): string {
  return renderToStaticMarkup(React.createElement(PlayerGrid, { seats: mockSeats, ...props }));
}

describe('PlayerGrid', () => {
  it('renders all seat display names', () => {
    const html = render();
    expect(html).toContain('铲屎官');
    expect(html).toContain('宪宪');
    expect(html).toContain('砚砚');
    expect(html).toContain('Dare');
  });

  it('renders seat IDs', () => {
    const html = render();
    expect(html).toContain('P1');
    expect(html).toContain('P2');
    expect(html).toContain('P6');
  });

  it('highlights active speaker with gold border', () => {
    const html = render({ activeSeatId: 'P2' });
    expect(html).toContain('data-testid="seat-P2"');
    // H6: Active seat now uses gold border (--ww-state-speaking), not bg-ww-cute
    const p2Match = html.match(/data-testid="seat-P2"[^>]*class="([^"]+)"/);
    expect(p2Match?.[1]).toContain('border-[var(--ww-state-speaking)]');
  });

  it('dims dead seat with opacity-40', () => {
    const html = render();
    const p6Match = html.match(/data-testid="seat-P6"[^>]*class="([^"]+)"/);
    expect(p6Match?.[1]).toContain('opacity-40');
  });

  it('renders avatar images with correct src', () => {
    const html = render();
    expect(html).toContain('src="/avatars/opus.png"');
    expect(html).toContain('src="/avatars/coCreator.png"');
    expect(html).toContain('src="/avatars/dare.png"');
  });

  it('shows 死亡 for dead seats', () => {
    const html = render();
    // P6 is dead, should show 死亡
    expect(html).toContain('死亡');
  });

  it('shows 发言中 for active seat', () => {
    const html = render({ activeSeatId: 'P2' });
    expect(html).toContain('发言中');
  });
});
