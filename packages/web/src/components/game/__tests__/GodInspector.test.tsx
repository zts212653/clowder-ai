import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GodInspector } from '../GodInspector';

Object.assign(globalThis as Record<string, unknown>, { React });

const seats = [
  { seatId: 'P1', role: '预言家', faction: 'seer', alive: true, status: '✓ 已行动' },
  { seatId: 'P3', role: '狼人', faction: 'wolf', alive: true, status: '✓ 已行动' },
  { seatId: 'P6', role: '猎人', faction: 'hunter', alive: false, status: '死亡' },
];

const nightSteps = [
  { roleName: '守卫', detail: '→ 守护 P2', status: 'done' as const },
  { roleName: '狼人', detail: '→ 刀 P4', status: 'done' as const },
  { roleName: '女巫', detail: '等待行动...', status: 'in_progress' as const },
  { roleName: '结算', detail: '待执行', status: 'pending' as const },
];

function render(overrides: Partial<Parameters<typeof GodInspector>[0]> = {}): string {
  return renderToStaticMarkup(
    React.createElement(GodInspector, {
      seats,
      nightSteps,
      scopeFilter: 'all',
      onScopeChange: () => {},
      ...overrides,
    }),
  );
}

describe('GodInspector', () => {
  it('renders seat matrix section', () => {
    const html = render();
    expect(html).toContain('座位表');
    expect(html).toContain('data-testid="seat-matrix"');
  });

  it('renders seat rows with roles', () => {
    const html = render();
    expect(html).toContain('预言家');
    expect(html).toContain('狼人');
    expect(html).toContain('猎人');
  });

  it('wolf seats have red background', () => {
    const html = render();
    const p3Match = html.match(/data-testid="matrix-P3"[^>]*class="([^"]+)"/);
    expect(p3Match?.[1]).toContain('bg-ww-danger-soft');
  });

  it('dead seats have reduced opacity', () => {
    const html = render();
    const p6Match = html.match(/data-testid="matrix-P6"[^>]*class="([^"]+)"/);
    expect(p6Match?.[1]).toContain('opacity-40');
  });

  it('renders night timeline section', () => {
    const html = render();
    expect(html).toContain('夜晚时间线');
    expect(html).toContain('data-testid="night-timeline"');
  });

  it('renders night steps with status icons', () => {
    const html = render();
    expect(html).toContain('守卫');
    expect(html).toContain('→ 守护 P2');
    expect(html).toContain('→ 刀 P4');
    expect(html).toContain('等待行动...');
  });

  it('renders scope filter tabs', () => {
    const html = render();
    expect(html).toContain('阵营筛选');
    expect(html).toContain('data-testid="scope-all"');
    expect(html).toContain('data-testid="scope-wolves"');
    expect(html).toContain('data-testid="scope-seer"');
    expect(html).toContain('data-testid="scope-witch"');
  });

  it('active scope tab is highlighted', () => {
    const html = render({ scopeFilter: 'all' });
    const allMatch = html.match(/data-testid="scope-all"[^>]*class="([^"]+)"/);
    expect(allMatch?.[1]).toContain('bg-ww-danger');
  });

  it('shows detective indicator when isDetective is true', () => {
    const html = render({ isDetective: true, detectiveBoundName: '宪宪' });
    expect(html).toContain('data-testid="detective-indicator"');
    expect(html).toContain('推理模式');
    expect(html).toContain('绑定: 宪宪');
  });

  it('hides god actions in detective mode', () => {
    const html = render({ isDetective: true, gameStatus: 'playing' });
    expect(html).not.toContain('data-testid="god-actions"');
  });

  it('shows god actions in non-detective mode', () => {
    const html = render({ gameStatus: 'playing' });
    expect(html).toContain('data-testid="god-actions"');
  });
});
