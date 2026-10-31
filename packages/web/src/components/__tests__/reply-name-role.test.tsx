import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { ReplyPill } from '../ReplyPill';
import { ReplyPreviewBar } from '../ReplyPreviewBar';

Object.assign(globalThis as Record<string, unknown>, { React });

const shell = vi.hoisted(() => ({ presentation: 'classic' as 'classic' | 'v2' }));

vi.mock('@/components/shell/shell-presentation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/shell/shell-presentation')>()),
  useShellPresentation: () => shell.presentation,
}));

vi.mock('@/hooks/useCoCreatorConfig', () => ({
  useCoCreatorConfig: () => ({
    name: '始皇帝',
    aliases: [],
    mentionPatterns: ['@owner'],
    color: { primary: '#D4A76A', secondary: '#FFF8F0' },
  }),
}));

/**
 * F322 B — in the new shell a cat's name on the reply pill and the reply bar is written in its readable name role
 * (`--color-{cat}-text`), the same token the message name uses, instead of in the cat's own identity hex. The tint behind the
 * name stays the identity colour (it says who). Classic is frozen: its markup must not move by a byte.
 *
 * These render to static markup so the raw `style` strings are visible (jsdom drops an eight-digit hex background); the shell
 * presentation hook is the only thing controlled here.
 */
const opus = { id: 'opus', displayName: '宪宪', color: { primary: '#8B5CF6', secondary: '#7C3AED' } } as CatData;
const getCatById = (id: string) => (id === 'opus' ? opus : undefined);

const pill = (senderCatId: string | null, extra: { deleted?: true } = {}) =>
  renderToStaticMarkup(
    <ReplyPill
      replyPreview={{
        from: senderCatId ? { kind: 'agent', catId: senderCatId } : { kind: 'user', userId: 'owner' },
        senderCatId,
        content: '内容',
        ...extra,
      }}
      replyToId="m1"
      getCatById={getCatById}
    />,
  );
const bar = (senderCatId: string | null) =>
  renderToStaticMarkup(
    <ReplyPreviewBar
      replyToMessage={{
        id: 'm1',
        from: senderCatId ? { kind: 'agent', catId: senderCatId } : { kind: 'user', userId: 'owner' },
        senderCatId,
        content: '内容',
      }}
      cats={[opus]}
      onClear={() => undefined}
    />,
  );

/** Every standalone `color:` declaration (not `background-color:`), in document order. */
const textColors = (html: string) => [...html.matchAll(/(?:^|[;"\s])color:([^;"]+)/g)].map((match) => match[1]);
const background = (html: string) => /background-color:([^;"]+)/.exec(html)?.[1];
const styleOfFirstElement = (html: string) => /style="([^"]*)"/.exec(html)?.[1];

describe('classic uses the approved theme-aware source pill and original composer bar', () => {
  it('the reply pill', () => {
    shell.presentation = 'classic';
    expect(styleOfFirstElement(pill('opus'))).toBe(
      'background-color:color-mix(in srgb, var(--color-opus-primary, #8B5CF6) 12.5%, transparent);color:var(--color-opus-primary, #8B5CF6)',
    );
  });

  it('the reply bar: the arrow, the line and the close button', () => {
    shell.presentation = 'classic';
    const html = bar('opus');
    expect(background(html)).toBe('#8B5CF618');
    expect(textColors(html)).toEqual(['#8B5CF6', '#8B5CF6', '#8B5CF6']);
  });

  it('the co-creator and an unknown cat, as before', () => {
    shell.presentation = 'classic';
    expect(textColors(pill(null))).toEqual(['var(--color-cocreator-text)']);
    expect(textColors(pill('ghost'))).toEqual(['#9B7EBD']);
    expect(textColors(bar(null))).toEqual(Array(3).fill('var(--color-cocreator-text)'));
    expect(textColors(bar('ghost'))).toEqual(Array(3).fill('#9B7EBD'));
  });
});

describe('the new shell writes a cat in its name role and keeps the tint', () => {
  it('the reply pill: text is the role, the 12.5% background is still the identity colour', () => {
    shell.presentation = 'v2';
    const html = pill('opus');
    expect(styleOfFirstElement(html)).toBe('background-color:#8B5CF620;color:var(--color-opus-text)');
  });

  it('a deleted reply keeps the same role colour (only the words go)', () => {
    shell.presentation = 'v2';
    expect(textColors(pill('opus', { deleted: true }))).toEqual(['var(--color-opus-text)']);
  });

  it('the reply bar: the arrow, the line and the close button all use the role; the tint is unchanged', () => {
    shell.presentation = 'v2';
    const html = bar('opus');
    expect(background(html)).toBe('#8B5CF618');
    expect(textColors(html)).toEqual(Array(3).fill('var(--color-opus-text)'));
  });

  it('the co-creator is already a role and an unknown cat has no token: both are left as they were', () => {
    shell.presentation = 'v2';
    expect(textColors(pill(null))).toEqual(['var(--color-cocreator-text)']);
    expect(textColors(pill('ghost'))).toEqual(['#9B7EBD']);
    expect(background(pill('ghost'))).toBe('#9B7EBD20');
    expect(textColors(bar(null))).toEqual(Array(3).fill('var(--color-cocreator-text)'));
    expect(textColors(bar('ghost'))).toEqual(Array(3).fill('#9B7EBD'));
  });

  it('following the presentation back to classic puts the hex back (nothing is remembered)', () => {
    shell.presentation = 'v2';
    expect(textColors(pill('opus'))).toEqual(['var(--color-opus-text)']);
    shell.presentation = 'classic';
    expect(textColors(pill('opus'))).toEqual(['var(--color-opus-primary, #8B5CF6)']);
  });
});
