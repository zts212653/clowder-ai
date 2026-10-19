import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { CatNameplate } from '../CatNameplate';

Object.assign(globalThis as Record<string, unknown>, { React });

const registry = vi.hoisted(() => ({ cats: [] as Array<{ id: string }> }));

// The real CatAvatar reads the same registry; a stub would hide the size and the ring the plate must ask it for.
vi.mock('@/hooks/useCatData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useCatData')>();
  return {
    ...actual,
    useCatData: () => ({
      getCatById: (id: string) => registry.cats.find((cat) => cat.id === id),
      cats: registry.cats,
      refresh: () => {},
    }),
  };
});

const OPUS = {
  id: 'opus',
  displayName: '布偶猫',
  nickname: '宪宪',
  breedId: 'ragdoll',
  avatar: '/avatars/opus.png',
  color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
  mentionPatterns: ['@opus'],
  clientId: 'anthropic',
  defaultModel: 'claude',
} as unknown as CatData;

/**
 * F322 B — the cat's nameplate with a 32px face (DESIGN.md「对话」, north-star §1.16 "名牌上的头像", You chose B on 2026-10-05):
 * the plate stays 26px high with the name at 13/600; the avatar grows from 16px to 32px and sits over the plate's left end,
 * its bottom edge 2px below the plate and its top above it, with a 2px ring in the work-surface colour that separates it
 * from the plate. The face carries no cat-coloured ring (the plate already is the cat's colour). The plate leaves 40px on
 * the left for the face and 10px on the right.
 *
 * Static markup, so the raw `style` strings are visible.
 */
const render = (props: Partial<React.ComponentProps<typeof CatNameplate>> = {}) => {
  registry.cats = [OPUS];
  return renderToStaticMarkup(<CatNameplate catId="opus" name="宪宪" {...props} />);
};
const attrsOf = (html: string, testId: string) =>
  new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? '';

describe('the nameplate carries a 32px face laid over its left end', () => {
  it('renders the accepted 26px plate with a 32px face below its edge through the shared CSS', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync('../ui/src/styles.css', 'utf8');
    document.head.append(style);
    const host = document.createElement('div');
    host.innerHTML = render();
    document.body.append(host);
    try {
      const plate = getComputedStyle(host.querySelector('[data-testid="cat-nameplate"]') as HTMLElement);
      const face = getComputedStyle(host.querySelector('[data-testid="cat-nameplate-avatar"]') as HTMLElement);
      const name = getComputedStyle(host.querySelector('[data-testid="cat-nameplate-name"]') as HTMLElement);
      expect(plate.height).toBe('26px');
      expect(plate.paddingLeft).toBe('40px');
      expect(plate.paddingRight).toBe('10px');
      expect(face.width).toBe('32px');
      expect(face.height).toBe('32px');
      expect(face.bottom).toBe('-2px');
      expect(face.boxShadow).toBe('0 0 0 2px var(--shell-work)');
      expect(name.fontSize).toBe('13px');
      expect(name.fontWeight).toBe('600');
      expect(name.textOverflow).toBe('ellipsis');
    } finally {
      host.remove();
      style.remove();
    }
  });

  it('fills the plate with the cat surface role, fading to transparent, as before', () => {
    expect(attrsOf(render(), 'cat-nameplate')).toContain(
      'linear-gradient(to bottom, var(--color-opus-surface), transparent)',
    );
  });

  it('asks the avatar for 32px and for no cat-coloured ring', () => {
    const html = render();
    // CatAvatar's own box is `size` square; without a ring it adds no ring-2 class
    expect(html).toMatch(/class="relative flex-shrink-0" style="width:32px;height:32px"/);
    expect(html).not.toContain('ring-2');
    expect(html).not.toMatch(/width:16px;height:16px/);
  });

  it('keeps the full name keyboard-accessible for the shared tooltip and consumes the cat name role', () => {
    const name = attrsOf(render({ title: '完整名字' }), 'cat-nameplate-name');
    expect(name).toContain('color:var(--color-opus-text)');
    expect(name).toContain('tabindex="0"');
    expect(name).not.toContain('title=');
  });

  it('keeps the v2 face still; observed activity belongs to the last line', () => {
    expect(render()).toContain('data-testid="cat-nameplate-avatar"');
    expect(render()).not.toContain('animate-pulse');
  });
});
