import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';

afterEach(() => {
  vi.resetModules();
});

function makeCat(overrides: Partial<CatData> & { id: string; mentionPatterns: string[] }): CatData {
  return {
    displayName: overrides.id,
    color: { primary: '#000', secondary: '#fff' },
    clientId: 'anthropic',
    defaultModel: 'test',
    roleDescription: '',
    personality: '',
    ...overrides,
  } as CatData;
}

describe('mention highlight cache', () => {
  it('excludes disabled cats (roster.available === false) from highlight (#193)', async () => {
    const { refreshMentionData, getMentionToCat, getMentionRe } = await import('@/lib/mention-highlight');
    const cats: CatData[] = [
      makeCat({
        id: 'spark',
        displayName: '火花猫',
        color: { primary: '#F59E0B', secondary: '#FDE68A' },
        mentionPatterns: ['@spark', '@火花猫'],
        roster: { family: 'maine-coon', roles: ['coder'], lead: false, available: false, evaluation: 'disabled' },
      }),
      makeCat({
        id: 'ragdoll',
        displayName: '布偶猫',
        color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
        mentionPatterns: ['@ragdoll', '@布偶猫'],
        roster: { family: 'ragdoll', roles: ['architect'], lead: true, available: true, evaluation: '' },
      }),
    ];

    refreshMentionData(cats);

    const toCat = getMentionToCat();
    // Disabled cat excluded
    expect(toCat.spark).toBeUndefined();
    expect(toCat['火花猫']).toBeUndefined();
    // Available cat included
    expect(toCat.ragdoll).toBe('ragdoll');
    expect(toCat['布偶猫']).toBe('ragdoll');

    const re = getMentionRe();
    re.lastIndex = 0;
    expect(re.exec('@spark')).toBeNull();
    re.lastIndex = 0;
    expect(re.exec('@ragdoll')).not.toBeNull();
  });

  it('includes cats without roster field (seed cats default to available)', async () => {
    const {
      getDisplayMentionRe,
      getDisplayMentionToCat,
      getMentionLabel,
      getMentionRe,
      getMentionToCat,
      isCanonicalOnlyMentionAlias,
      refreshMentionData,
    } = await import('@/lib/mention-highlight');
    refreshMentionData([
      makeCat({
        id: 'seed-cat',
        displayName: '种子猫',
        variantLabel: 'seed',
        mentionPatterns: ['@seed'],
        roster: null as never,
      }),
    ]);
    expect(getMentionToCat().seed).toBe('seed-cat');
    expect(getMentionToCat()['seed-cat']).toBeUndefined();
    expect(getDisplayMentionToCat()['seed-cat']).toBe('seed-cat');
    expect(isCanonicalOnlyMentionAlias('seed-cat')).toBe(true);
    expect(isCanonicalOnlyMentionAlias('seed')).toBe(false);
    expect(getMentionLabel()['seed-cat']).toBe('种子猫（seed）');
    expect(getMentionRe().exec('@seed-cat')).toBeNull();
    expect(getDisplayMentionRe().exec('@seed-cat')).not.toBeNull();
  });
});
