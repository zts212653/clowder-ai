import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContextHealthBar } from '../ContextHealthBar';

Object.assign(globalThis as Record<string, unknown>, { React });

function render(catId: string): string {
  return renderToStaticMarkup(
    React.createElement(ContextHealthBar, {
      catId,
      health: {
        usedTokens: 60000,
        windowTokens: 150000,
        fillRatio: 0.4,
        source: 'exact',
        measuredAt: Date.now(),
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

  it('labels last-turn health as current context fill', () => {
    const html = renderToStaticMarkup(
      React.createElement(ContextHealthBar, {
        catId: 'gemini',
        health: {
          usedTokens: 34000,
          windowTokens: 1000000,
          fillRatio: 0.034,
          source: 'exact',
          usedFrom: 'last_turn',
          measuredAt: Date.now(),
        },
      }),
    );
    expect(html).toContain('Current context fill: 3%');
  });

  it('labels input fallback so cumulative values are not mistaken for context fill', () => {
    const html = renderToStaticMarkup(
      React.createElement(ContextHealthBar, {
        catId: 'gemini',
        health: {
          usedTokens: 452200,
          windowTokens: 1000000,
          fillRatio: 0.4522,
          source: 'exact',
          usedFrom: 'input',
          measuredAt: Date.now(),
        },
      }),
    );
    expect(html).toContain('Input-token fallback for context health; may be cumulative');
  });
});
