import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';

afterEach(() => {
  vi.resetModules();
});

describe('mention highlight cache', () => {
  it('preserves aliases for unavailable cats in historical transcript rendering', async () => {
    const mentionHighlightModule = await import('@/lib/mention-highlight');
    const cats: CatData[] = [
      {
        id: 'spark',
        displayName: '火花猫',
        color: { primary: '#F59E0B', secondary: '#FDE68A' },
        mentionPatterns: ['@spark', '@火花猫'],
        provider: 'openai',
        defaultModel: 'gpt-5.4-mini',
        avatar: '/avatars/spark.png',
        roleDescription: '精确点改',
        personality: 'fast',
        roster: {
          family: 'maine-coon',
          roles: ['coder'],
          lead: false,
          available: false,
          evaluation: 'disabled for test',
        },
      },
    ];

    mentionHighlightModule.refreshMentionData(cats);

    const toCat = mentionHighlightModule.getMentionToCat();
    expect(toCat.spark).toBe('spark');
    expect(toCat['火花猫']).toBe('spark');

    const re = mentionHighlightModule.getMentionRe();
    re.lastIndex = 0;
    expect(re.exec('历史消息里仍然提到 @spark')).not.toBeNull();
  });
});
