import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NightStatus } from '../NightStatus';

Object.assign(globalThis as Record<string, unknown>, { React });

function render(roleName: string, actionHint: string): string {
  return renderToStaticMarkup(React.createElement(NightStatus, { roleName, actionHint }));
}

describe('NightStatus', () => {
  it('renders role name', () => {
    const html = render('预言家', '请选择查验目标');
    expect(html).toContain('预言家');
  });

  it('renders action hint', () => {
    const html = render('预言家', '请选择查验目标');
    expect(html).toContain('请选择查验目标');
  });

  it('renders status dot', () => {
    const html = render('守卫', '请选择守护目标');
    expect(html).toContain('data-testid="status-dot"');
    expect(html).toContain('bg-ww-success');
  });

  it('renders combined text format', () => {
    const html = render('预言家', '请选择查验目标');
    expect(html).toContain('你的身份：预言家 · 请选择查验目标');
  });
});
