import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GameShell } from '../GameShell';

Object.assign(globalThis as Record<string, unknown>, { React });

function render(props: { onClose: () => void; isNight?: boolean; children?: React.ReactNode }): string {
  return renderToStaticMarkup(React.createElement(GameShell, props));
}

describe('GameShell', () => {
  it('renders full-screen overlay with data-testid', () => {
    const html = render({ onClose: () => {} });
    expect(html).toContain('data-testid="game-shell"');
  });

  it('renders children', () => {
    const html = renderToStaticMarkup(
      React.createElement(GameShell, { onClose: () => {} }, React.createElement('div', { 'data-testid': 'child' })),
    );
    expect(html).toContain('data-testid="child"');
  });

  it('applies dark background', () => {
    const html = render({ onClose: () => {} });
    expect(html).toContain('bg-ww-base');
  });

  it('applies night filter when isNight=true', () => {
    const html = render({ onClose: () => {}, isNight: true });
    expect(html).toContain('saturate-75');
  });

  it('does not apply night filter when isNight=false', () => {
    const html = render({ onClose: () => {}, isNight: false });
    expect(html).not.toContain('saturate-75');
  });
});
