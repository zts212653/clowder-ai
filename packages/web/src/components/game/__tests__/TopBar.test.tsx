import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TopBar } from '../TopBar';

Object.assign(globalThis as Record<string, unknown>, { React });

function render(props: Partial<Parameters<typeof TopBar>[0]> = {}): string {
  return renderToStaticMarkup(
    React.createElement(TopBar, {
      phaseName: '自由讨论',
      roundInfo: '第 2 轮 · 9 人局',
      timeLeftMs: 154000,
      isNight: false,
      ...props,
    }),
  );
}

describe('TopBar', () => {
  it('renders phase name', () => {
    const html = render();
    expect(html).toContain('自由讨论');
  });

  it('renders round info', () => {
    const html = render();
    expect(html).toContain('第 2 轮 · 9 人局');
  });

  it('renders countdown timer with data-testid', () => {
    const html = render();
    expect(html).toContain('data-testid="countdown"');
  });

  it('formats time correctly (154000ms = 02:34)', () => {
    const html = render({ timeLeftMs: 154000 });
    expect(html).toContain('02:34');
  });

  it('formats zero time', () => {
    const html = render({ timeLeftMs: 0 });
    expect(html).toContain('00:00');
  });

  it('uses night style when isNight', () => {
    const html = render({ isNight: true });
    expect(html).toContain('bg-ww-topbar');
  });

  it('uses day style when not night', () => {
    const html = render({ isNight: false });
    expect(html).toContain('bg-ww-topbar');
  });

  it('renders close button when onClose provided', () => {
    const html = render({ onClose: () => {} });
    expect(html).toContain('data-testid="game-close-btn"');
    expect(html).toContain('最小化游戏');
  });

  it('does not render close button when onClose omitted', () => {
    const html = render();
    expect(html).not.toContain('data-testid="game-close-btn"');
  });
});
