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
    expect(result.color).toBe('#D4A76A'); // CO_CREATOR_COLOR.primary
  });
});
