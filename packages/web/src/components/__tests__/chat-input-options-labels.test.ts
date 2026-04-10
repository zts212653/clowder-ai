import { describe, expect, it } from 'vitest';
import { buildCatOptions, buildWhisperOptions } from '@/components/chat-input-options';
import type { CatData } from '@/hooks/useCatData';

const FAKE_CATS: CatData[] = [
  {
    id: 'gemini',
    displayName: '暹罗猫',
    color: { primary: '#5B9BD5', secondary: '#D6E9F8' },
    mentionPatterns: ['暹罗', '暹罗猫', 'gemini'],
    clientId: 'google',
    defaultModel: 'gemini-3-pro',
    avatar: '/avatars/gemini.png',
    roleDescription: '视觉设计师',
    personality: '活泼有创意',
    source: 'seed',
  },
];

const MIXED_CATS: CatData[] = [
  ...FAKE_CATS,
  {
    id: 'opus-fast',
    displayName: '布偶猫(快)',
    color: { primary: '#9B7EBD', secondary: '#E8D5F5' },
    mentionPatterns: [],
    clientId: 'anthropic',
    defaultModel: 'opus-fast',
    avatar: '/avatars/opus.png',
    roleDescription: '快速变体',
    personality: 'kind',
    source: 'seed',
  },
  {
    id: 'spark',
    displayName: '火花猫',
    color: { primary: '#F59E0B', secondary: '#FDE68A' },
    mentionPatterns: ['spark'],
    clientId: 'openai',
    defaultModel: 'gpt-5.4-mini',
    avatar: '/avatars/spark.png',
    roleDescription: '精确点改',
    personality: 'fast',
    source: 'seed',
    roster: {
      family: 'maine-coon',
      roles: ['coder'],
      lead: false,
      available: false,
      evaluation: 'disabled for test',
    },
  },
];

describe('chat input mention option labels', () => {
  it('uses official 暹罗猫 label/insert for gemini option', () => {
    const options = buildCatOptions(FAKE_CATS);
    const geminiOption = options.find((opt) => opt.id === 'gemini');
    expect(geminiOption).toBeDefined();
    expect(geminiOption?.label).toBe('@暹罗猫');
    expect(geminiOption?.insert).toBe('@暹罗 ');
  });

  it('only uses the first mention pattern for autocomplete insert text', () => {
    const options = buildCatOptions(FAKE_CATS);
    expect(options[0]?.insert).toBe('@暹罗 ');
    expect(options[0]?.insert).not.toBe('@暹罗猫 ');
    expect(options[0]?.insert).not.toBe('@gemini ');
  });
});

describe('buildCatOptions vs buildWhisperOptions split', () => {
  it('buildCatOptions filters out cats with empty mentionPatterns', () => {
    const options = buildCatOptions(MIXED_CATS);
    expect(options).toHaveLength(1);
    expect(options[0].id).toBe('gemini');
  });

  it('buildCatOptions filters out unavailable cats even when they have mention patterns', () => {
    const options = buildCatOptions(MIXED_CATS);
    expect(options.map((option) => option.id)).not.toContain('spark');
  });

  it('buildWhisperOptions includes cats with empty mentionPatterns', () => {
    const options = buildWhisperOptions(MIXED_CATS);
    expect(options).toHaveLength(2);
    const fast = options.find((o) => o.id === 'opus-fast');
    expect(fast).toBeDefined();
    expect(fast?.label).toBe('@布偶猫(快)');
    expect(fast?.insert).toBe(''); // no mentionPatterns → empty insert
    expect(options.map((option) => option.id)).not.toContain('spark');
  });
});
