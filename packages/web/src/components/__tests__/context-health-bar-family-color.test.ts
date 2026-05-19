import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContextHealthBar } from '../ContextHealthBar';

Object.assign(globalThis as Record<string, unknown>, { React });

function render(catId: string, health: Partial<React.ComponentProps<typeof ContextHealthBar>['health']> = {}): string {
  return renderToStaticMarkup(
    React.createElement(ContextHealthBar, {
      catId,
      health: {
        usedTokens: 60000,
        windowTokens: 150000,
        fillRatio: 0.4,
        source: 'exact',
        usedFrom: 'last_turn',
        measuredAt: Date.now(),
        ...health,
      },
    }),
  );
}

describe('ContextHealthBar family variant colors', () => {
  it('uses maine-coon green shade for gpt52', () => {
    const html = render('gpt52');
    expect(html).toContain('background-color:#66BB6A');
  });

  it('uses ragdoll purple shade for sonnet', () => {
    const html = render('sonnet');
    expect(html).toContain('background-color:#B39DDB');
  });

  it('labels last-turn context health as current context fill', () => {
    const html = render('gemini');
    expect(html).toContain('Current context fill: 40%');
  });

  it('labels input fallback as potentially cumulative', () => {
    const html = render('gemini', { usedFrom: 'input' });
    expect(html).toContain('Input-token fallback for context health; may be cumulative: 40%');
  });
});
