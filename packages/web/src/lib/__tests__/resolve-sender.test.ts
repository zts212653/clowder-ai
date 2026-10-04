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
    expect(result.label).toBe('@宪宪');
    expect(result.color).toBe('#8B5CF6');
    expect(result.isCoCreator).toBe(false);
  });

  it('falls back for unknown cat ID', () => {
    const result = resolveSender('unknown-cat', mockGetCatById, mockCoCreator);
    expect(result.label).toBe('@unknown-cat');
    expect(result.color).toBe('#9B7EBD');
    expect(result.isCoCreator).toBe(false);
  });

  it('uses CO_CREATOR_COLOR when coCreator config has no color', () => {
    const noColor = { ...mockCoCreator, color: undefined as never };
    const result = resolveSender(null, mockGetCatById, noColor);
    expect(result.color).toBe('#6B5443'); // CO_CREATOR_COLOR.primary (cocoa)
  });
});
