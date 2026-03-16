import type { SeatView } from '@cat-cafe/shared';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NightActionCard } from '../NightActionCard';

Object.assign(globalThis as Record<string, unknown>, { React });

const targets: SeatView[] = [
  { seatId: 'P2', actorType: 'cat', actorId: 'opus', displayName: '宪宪', alive: true },
  { seatId: 'P3', actorType: 'cat', actorId: 'codex', displayName: '砚砚', alive: true },
  { seatId: 'P6', actorType: 'cat', actorId: 'dare', displayName: 'Dare', alive: false },
];

function render(overrides: Partial<Parameters<typeof NightActionCard>[0]> = {}): string {
  return renderToStaticMarkup(
    React.createElement(NightActionCard, {
      roleName: '预言家',
      roleIcon: '🔮',
      actionLabel: '查验',
      hint: '选择一名玩家查验其身份',
      targets,
      selectedTarget: null,
      onSelectTarget: () => {},
      onConfirm: () => {},
      ...overrides,
    }),
  );
}

describe('NightActionCard', () => {
  it('renders role header', () => {
    const html = render();
    expect(html).toContain('预言家');
    expect(html).toContain('🔮');
    expect(html).toContain('查验');
  });

  it('renders target grid with seats', () => {
    const html = render();
    expect(html).toContain('data-testid="target-P2"');
    expect(html).toContain('data-testid="target-P3"');
    expect(html).toContain('宪宪');
    expect(html).toContain('砚砚');
  });

  it('dims dead targets', () => {
    const html = render();
    const p6Match = html.match(/data-testid="target-P6"[^>]*class="([^"]+)"/);
    expect(p6Match?.[1]).toContain('opacity-40');
  });

  it('shows selected target border', () => {
    const html = render({ selectedTarget: 'P2' });
    const p2Match = html.match(/data-testid="target-P2"[^>]*class="([^"]+)"/);
    expect(p2Match?.[1]).toContain('border-ww-cute');
  });

  it('confirm button shows target when selected', () => {
    const html = render({ selectedTarget: 'P2' });
    expect(html).toContain('确认查验 P2');
  });

  it('confirm button shows placeholder when no target', () => {
    const html = render({ selectedTarget: null });
    expect(html).toContain('请选择目标');
  });

  it('renders hint text', () => {
    const html = render();
    expect(html).toContain('选择一名玩家查验其身份');
  });
});
