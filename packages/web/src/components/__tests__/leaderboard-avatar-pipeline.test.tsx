import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CatHeroCard, MiniRanked } from '@/components/leaderboard-cards';
import { SillyCatsList } from '@/components/leaderboard-phase-bc';

vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: ({ catId, size }: { catId: string; size?: number }) =>
    React.createElement('span', { 'data-testid': `cat-avatar-${catId}-${size ?? 32}` }, catId),
}));

describe('F075 leaderboard avatar pipeline', () => {
  it('uses shared CatAvatar pipeline for hero cards', () => {
    const html = renderToStaticMarkup(
      React.createElement(CatHeroCard, {
        cat: {
          catId: 'gpt52',
          displayName: '缅因猫',
          count: 829,
          rank: 3,
        },
        unit: 'times mentioned',
      }),
    );

    expect(html).toContain('cat-avatar-gpt52-72');
    expect(html).not.toContain('opus-kawaii');
  });

  it('uses shared CatAvatar pipeline for compact mention and silly lists', () => {
    const miniHtml = renderToStaticMarkup(
      React.createElement(MiniRanked, {
        items: [
          {
            catId: 'gpt52',
            displayName: '缅因猫',
            count: 3,
            rank: 1,
          },
        ],
        unit: '次',
      }),
    );

    const sillyHtml = renderToStaticMarkup(
      React.createElement(SillyCatsList, {
        entries: [
          {
            catId: 'gpt52',
            displayName: '缅因猫',
            label: '社死王',
            description: '被铲屎官吐槽',
            count: 2,
          },
        ],
      }),
    );

    expect(miniHtml).toContain('cat-avatar-gpt52-24');
    expect(sillyHtml).toContain('cat-avatar-gpt52-24');
    expect(miniHtml).not.toContain('opus-kawaii');
    expect(sillyHtml).not.toContain('opus-kawaii');
  });
});
