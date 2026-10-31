import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { DirectionPill } from '../DirectionPill';

Object.assign(globalThis as Record<string, unknown>, { React });

const shell = vi.hoisted(() => ({ presentation: 'classic' as 'classic' | 'v2', language: 'zh' as 'zh' | 'en' }));
const catsById = vi.hoisted(() => ({
  current: {} as Record<string, { id: string; displayName: string; color: { primary: string; secondary: string } }>,
}));

vi.mock('@/components/shell/shell-presentation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/shell/shell-presentation')>()),
  useShellPresentation: () => shell.presentation,
}));

vi.mock('@/components/shell/shell-language', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/shell/shell-language')>()),
  useShellLanguage: () => shell.language,
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: (id: string) => catsById.current[id] }),
  formatCatName: (cat: { displayName: string }) => cat.displayName,
}));

vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: ({ status }: { status?: string }) =>
    React.createElement('span', { 'data-testid': 'cat-avatar', 'data-status': status ?? '' }, 'avatar'),
}));

/**
 * F322 B — the direction pill ("→ @猫名") and the member-pending bubble in the new shell. Classic is frozen: its markup must
 * not move by a byte. Static markup, so the raw `style` strings are visible (jsdom drops an eight-digit hex background); the
 * shell presentation and language hooks are the only things controlled here.
 *
 * Direction pill, new shell: a cat's name is written in its readable name role with the 12.5% identity tint behind it. A target
 * with no cat behind it (an id the catalogue does not know, a cross-thread pointer) is not a cat, so it carries no cat colour:
 * the body text role on the neutral surface-3 base (`--shell-body` on `--shell-selected`); the arrow stays.
 *
 * Pending bubble, new shell: it is the same nameplate as the real reply that replaces it, with one line under it,
 * 「已接下，还没有输出」 / "Request received, no output yet"; no avatar column, no dots. A cat the catalogue does not know gets the
 * name in the body role, without a plate.
 */
const opus: CatData = {
  id: 'opus',
  displayName: '宪宪',
  color: { primary: '#8B5CF6', secondary: '#7C3AED' },
} as CatData;
const getCatById = (id: string) => (id === 'opus' ? opus : undefined);

const direction = { type: 'mention' as const, targets: ['opus'], arrow: '→' as const };
const pill = (d: typeof direction | { type: 'crossPost'; targets: string[]; arrow: '↗' }, lookup = getCatById) =>
  renderToStaticMarkup(<DirectionPill direction={d as never} getCatById={lookup} />);
const styleOfFirstElement = (html: string) => /style="([^"]*)"/.exec(html)?.[1];
const NEUTRAL = 'background-color:var(--shell-selected);color:var(--shell-body)';

describe('DirectionPill', () => {
  describe('classic is byte-identical: the cat is written in its own hex', () => {
    it('known cat', () => {
      shell.presentation = 'classic';
      expect(styleOfFirstElement(pill(direction))).toBe('background-color:#8B5CF620;color:#8B5CF6');
    });

    it('unknown target and a cross-post keep the fallback colour', () => {
      shell.presentation = 'classic';
      expect(styleOfFirstElement(pill({ ...direction, targets: ['ghost'] }))).toBe(
        'background-color:#9B7EBD20;color:#9B7EBD',
      );
      expect(styleOfFirstElement(pill({ type: 'crossPost', targets: ['thread-a'], arrow: '↗' }))).toBe(
        'background-color:#9B7EBD20;color:#9B7EBD',
      );
    });
  });

  describe('new shell', () => {
    it('known cat: --color-{cat}-text for the words, the cat hex at 12.5% behind them', () => {
      shell.presentation = 'v2';
      expect(styleOfFirstElement(pill(direction))).toBe('background-color:#8B5CF620;color:var(--color-opus-text)');
    });

    it('the words and the arrow do not change', () => {
      shell.presentation = 'v2';
      expect(pill(direction)).toContain('→ @宪宪');
      expect(pill({ type: 'crossPost', targets: ['abcdef12'], arrow: '↗' })).toContain('↗ abcdef12');
      expect(pill({ ...direction, targets: ['ghost'] })).toContain('→ @ghost');
    });

    it('unknown target: no cat colour anywhere, the body text role on the neutral base', () => {
      shell.presentation = 'v2';
      expect(styleOfFirstElement(pill({ ...direction, targets: ['ghost'] }))).toBe(NEUTRAL);
    });

    it('a cross-thread pointer: the same neutral pill, with its arrow kept as the sign that it is cross-thread', () => {
      shell.presentation = 'v2';
      const html = pill({ type: 'crossPost', targets: ['abcdef12'], arrow: '↗' });
      expect(styleOfFirstElement(html)).toBe(NEUTRAL);
      expect(html).toContain('↗');
    });

    it('a catalogued cat whose id is not CSS-safe still points at the same token the message name uses', () => {
      shell.presentation = 'v2';
      const odd = (id: string) =>
        id === 'odd id'
          ? ({ id, displayName: '怪', color: { primary: '#123456', secondary: '#654321' } } as CatData)
          : undefined;
      // catSlug() sends an unsafe id to the co-creator token rather than to a var() that does not exist.
      expect(styleOfFirstElement(pill({ ...direction, targets: ['odd id'] }, odd))).toBe(
        'background-color:#12345620;color:var(--color-cocreator-text)',
      );
    });
  });
});
