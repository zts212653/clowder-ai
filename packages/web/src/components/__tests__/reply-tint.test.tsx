import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { DirectionPill } from '../DirectionPill';
import { ReplyPill } from '../ReplyPill';
import { ReplyPreviewBar } from '../ReplyPreviewBar';

Object.assign(globalThis as Record<string, unknown>, { React });

const config = vi.hoisted(() => ({ primary: '#D4A76A' as string | null }));

vi.mock('@/hooks/useCoCreatorConfig', () => ({
  useCoCreatorConfig: () => ({
    name: '始皇帝',
    aliases: [],
    mentionPatterns: ['@owner'],
    ...(config.primary ? { color: { primary: config.primary, secondary: '#FFF8F0' } } : {}),
  }),
}));

/**
 * F322 B — the reply pill (alpha 0x20), the reply bar (0x18) and the direction pill (0x20) tint their background with the
 * sender's identity colour. The human's colour is configurable and the config chain accepts #RGB, #RGBA and #RRGGBBAA, so
 * the tint must be a valid colour for every opaque spelling, and absent (never invalid) for a translucent one. Cats keep
 * the colour spelling they ship with, byte for byte.
 */
const cat = (id: string, primary: string): CatData =>
  ({ id, displayName: id, color: { primary, secondary: '#eeeeee' } }) as CatData;
const opus = cat('opus', '#8B5CF6');
const getCatById = (id: string) => (id === 'opus' ? opus : undefined);

const pill = (senderCatId: string | null) =>
  renderToStaticMarkup(
    <ReplyPill replyPreview={{ senderCatId, content: '内容' }} replyToId="m1" getCatById={getCatById} />,
  );
const bar = (senderCatId: string | null) =>
  renderToStaticMarkup(
    <ReplyPreviewBar
      replyToMessage={{ id: 'm1', senderCatId, content: '内容' }}
      cats={[opus]}
      onClear={() => undefined}
    />,
  );
const background = (html: string) => /background-color:([^;"]+)/.exec(html)?.[1];

describe('the human colour tints the reply pill and the reply bar in every opaque spelling', () => {
  it.each([
    ['six-digit', '#D4A76A', '#D4A76A'],
    ['eight-digit opaque', '#D4A76Aff', '#d4a76a'],
    ['three-digit', '#fa0', '#ffaa00'],
    ['four-digit opaque', '#fa0f', '#ffaa00'],
  ])('%s: %s', (_name, primary, six) => {
    config.primary = primary;
    expect(background(pill(null))).toBe(`${six}20`);
    expect(background(bar(null))).toBe(`${six}18`);
  });

  it('paints no tint (and writes no invalid value) for a translucent human colour', () => {
    for (const primary of ['#D4A76A80', '#fa08']) {
      config.primary = primary;
      expect(background(pill(null)), primary).toBeUndefined();
      expect(background(bar(null)), primary).toBeUndefined();
    }
  });

  it('keeps the cocoa fallback tint when the config carries no colour', () => {
    config.primary = null;
    expect(background(pill(null))).toBe('#6B544320');
    expect(background(bar(null))).toBe('#6B544318');
  });
});

describe('a cat keeps the colour spelling it ships with, and an unknown cat the fallback', () => {
  it('known cat: byte-identical to the old string-appended tint', () => {
    config.primary = '#D4A76A';
    expect(background(pill('opus'))).toBe('#8B5CF620');
    expect(background(bar('opus'))).toBe('#8B5CF618');
  });

  it('unknown cat: the unknown-cat fallback colour', () => {
    expect(background(pill('ghost'))).toBe('#9B7EBD20');
    expect(background(bar('ghost'))).toBe('#9B7EBD18');
  });
});

describe('DirectionPill', () => {
  const direction = { type: 'mention' as const, targets: ['opus'], arrow: '→' as const };

  it('known cat: its colour with the tint after it; unknown target: the fallback', () => {
    expect(background(renderToStaticMarkup(<DirectionPill direction={direction} getCatById={getCatById} />))).toBe(
      '#8B5CF620',
    );
    expect(
      background(
        renderToStaticMarkup(
          <DirectionPill direction={{ ...direction, targets: ['ghost'] }} getCatById={getCatById} />,
        ),
      ),
    ).toBe('#9B7EBD20');
  });

  it('a cat configured with an opaque eight-digit colour tints like its six-digit form', () => {
    const cats: Record<string, CatData> = { eight: cat('eight', '#6666ffff') };
    const html = renderToStaticMarkup(
      <DirectionPill direction={{ ...direction, targets: ['eight'] }} getCatById={(id) => cats[id]} />,
    );
    expect(background(html)).toBe('#6666ff20');
  });
});
