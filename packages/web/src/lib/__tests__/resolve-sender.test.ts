import { describe, expect, it } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { resolveSender } from '../resolve-sender';

const mockCoCreator = {
  name: '始皇帝',
  aliases: ['秦始皇'],
  mentionPatterns: ['@owner'],
  color: { primary: '#D4A76A', secondary: '#FFF8F0' },
};

const mockGetCatById = (id: string): CatData | undefined => {
  const cats: Record<string, Partial<CatData>> = {
    opus: { id: 'opus', displayName: '宪宪', color: { primary: '#8B5CF6', secondary: '#7C3AED' } },
  };
  return cats[id] as CatData | undefined;
};

describe('resolveSender', () => {
  it('resolves co-creator when senderCatId is null', () => {
    const result = resolveSender(null, mockGetCatById, mockCoCreator);
    expect(result.label).toBe('始皇帝');
    expect(result.color).toBe('#D4A76A');
    expect(result.isCoCreator).toBe(true);
  });

  it('draws the co-creator in text with the shared readable name role, not with the identity fill', () => {
    const result = resolveSender(null, mockGetCatById, mockCoCreator);
    // The fill colour is an identity, and may be dark in a dark theme; text in it must come from the role that is made to read.
    expect(result.color).toBe('#D4A76A');
    expect(result.textColor).toBe('var(--color-cocreator-text)');
  });

  it('keeps a cat or an unknown id as it was: its colour is also its text colour', () => {
    expect(resolveSender('opus', mockGetCatById, mockCoCreator).textColor).toBe('#8B5CF6');
    expect(resolveSender('unknown-cat', mockGetCatById, mockCoCreator).textColor).toBe('#9B7EBD');
  });

  it('resolves known cat by ID', () => {
    const result = resolveSender('opus', mockGetCatById, mockCoCreator);
    expect(result.label).toBe('宪宪');
    expect(result.color).toBe('#8B5CF6');
    expect(result.isCoCreator).toBe(false);
  });

  it('falls back for unknown cat ID', () => {
    const result = resolveSender('unknown-cat', mockGetCatById, mockCoCreator);
    expect(result.label).toBe('unknown-cat');
    expect(result.color).toBe('#9B7EBD');
    expect(result.isCoCreator).toBe(false);
  });

  it('uses CO_CREATOR_COLOR when coCreator config has no color', () => {
    const noColor = { ...mockCoCreator, color: undefined as never };
    const result = resolveSender(null, mockGetCatById, noColor);
    expect(result.color).toBe('#6B5443'); // CO_CREATOR_COLOR.primary (cocoa)
  });
});

/**
 * F322 B (new shell only) — a cat's name is written in its readable name role, `--color-{cat}-text`, not in the cat's own
 * identity hex. The identity colour stays the fill (the 12.5% tint behind the name says "who"); only the text changes.
 * Off by default: every caller that does not ask keeps the cat's hex as its text, byte for byte (classic is frozen).
 */
describe('resolveSender with the name role (new shell)', () => {
  const named = { nameRole: true } as const;

  it('writes a known cat in its name role and keeps the identity colour as the fill', () => {
    const result = resolveSender('opus', mockGetCatById, mockCoCreator, named);
    expect(result.textColor).toBe('var(--color-opus-text)');
    expect(result.color).toBe('#8B5CF6');
    expect(result.label).toBe('宪宪');
    expect(result.isCoCreator).toBe(false);
  });

  it('is off unless asked: no options and an explicit false both leave the cat hex as the text', () => {
    expect(resolveSender('opus', mockGetCatById, mockCoCreator).textColor).toBe('#8B5CF6');
    expect(resolveSender('opus', mockGetCatById, mockCoCreator, { nameRole: false }).textColor).toBe('#8B5CF6');
  });

  it('does not touch the co-creator (already a role) or an unknown id (it has no token to point at)', () => {
    expect(resolveSender(null, mockGetCatById, mockCoCreator, named).textColor).toBe('var(--color-cocreator-text)');
    expect(resolveSender('unknown-cat', mockGetCatById, mockCoCreator, named).textColor).toBe('#9B7EBD');
  });

  it('points at the same token the message name uses, including for an id that is not CSS-safe', () => {
    const odd = (id: string): CatData | undefined =>
      id === 'odd id'
        ? ({ id, displayName: '怪', color: { primary: '#123456', secondary: '#654321' } } as CatData)
        : undefined;
    // catSlug() sends an unsafe id to the co-creator token rather than to a var() that does not exist.
    expect(resolveSender('odd id', odd, mockCoCreator, named).textColor).toBe('var(--color-cocreator-text)');
  });
});
