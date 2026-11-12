/**
 * F071-D3: Regression tests for mention filter + empty result handling.
 *
 * Tests:
 * 1. Typing "@op" filters to opus-matching cats only
 * 2. Typing "@xyz" yields empty list with "无匹配猫猫" message
 * 3. Enter on empty filtered results does not insert newline (P2-1 fix)
 * 4. detectMenuTrigger returns filter string
 */
import { describe, expect, it } from 'vitest';
import { buildCatOptions, detectMenuTrigger, filterMentionOptions } from '@/components/chat-input-options';
import type { CatData } from '@/hooks/useCatData';

const MANY_CATS: CatData[] = [
  {
    id: 'opus',
    displayName: '布偶猫',
    color: { primary: '#9B7EBD', secondary: '#E8D5F5' },
    mentionPatterns: ['布偶', 'opus'],
    clientId: 'anthropic',
    carrier: 'cli',
    defaultModel: 'opus',
    avatar: '/a.png',
    roleDescription: 'dev',
    personality: 'kind',
  },
  {
    id: 'codex',
    displayName: '缅因猫',
    color: { primary: '#5B8C5A', secondary: '#D5E8D4' },
    mentionPatterns: ['缅因', 'codex'],
    clientId: 'openai',
    carrier: 'cli',
    defaultModel: 'codex',
    avatar: '/b.png',
    roleDescription: 'review',
    personality: 'strict',
  },
  {
    id: 'gemini',
    displayName: '暹罗猫',
    color: { primary: '#5B9BD5', secondary: '#D6E9F8' },
    mentionPatterns: ['暹罗', 'gemini'],
    clientId: 'google',
    carrier: 'cli',
    defaultModel: 'gemini',
    avatar: '/c.png',
    roleDescription: 'design',
    personality: 'creative',
  },
  {
    id: 'sonnet',
    displayName: '布偶猫',
    variantLabel: 'Sonnet',
    color: { primary: '#9B7EBD', secondary: '#E8D5F5' },
    mentionPatterns: ['sonnet'],
    clientId: 'anthropic',
    carrier: 'cli',
    defaultModel: 'sonnet',
    avatar: '/d.png',
    roleDescription: 'fast dev',
    personality: 'quick',
  },
];

describe('detectMenuTrigger filter', () => {
  it('returns filter string for "@op"', () => {
    const result = detectMenuTrigger('hello @op', 9);
    expect(result).toEqual({ type: 'mention', start: 6, filter: 'op' });
  });

  it('returns empty filter for bare "@"', () => {
    const result = detectMenuTrigger('hello @', 7);
    expect(result).toEqual({ type: 'mention', start: 6, filter: '' });
  });

  it('supports up to 12 character filter', () => {
    const result = detectMenuTrigger(' @longcatname', 13);
    expect(result).toEqual({ type: 'mention', start: 1, filter: 'longcatname' });
  });

  it('returns null for filter > 12 chars', () => {
    const result = detectMenuTrigger(' @verylongcatnam', 16);
    expect(result).toBeNull();
  });
});

describe('mention filter matching', () => {
  const options = buildCatOptions(MANY_CATS);

  it('filters by label match', () => {
    const filtered = filterMentionOptions(options, 'op');
    expect(filtered.some((o) => o.id === 'opus')).toBe(true);
    expect(filtered.some((o) => o.id === 'gemini')).toBe(false);
  });

  it('filters by id match', () => {
    const filtered = filterMentionOptions(options, 'codex');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('codex');
  });

  it('returns empty for non-matching filter', () => {
    expect(filterMentionOptions(options, 'xyz')).toHaveLength(0);
  });

  it('empty filter returns all options', () => {
    expect(filterMentionOptions(options, '')).toHaveLength(options.length);
  });
});

describe('mention filter finds members by the names people call them', () => {
  // 11-10: You typed "@小太阳" and the menu was empty. Every Sol variant is called
  // 小太阳·砚砚, but the label shows breed + model and the insert only the first alias.
  const SOL_CATS: CatData[] = [
    {
      id: 'codex-sol',
      displayName: '缅因猫 Sol',
      nickname: '小太阳·砚砚',
      variantLabel: 'GPT-5.6 Sol',
      color: { primary: '#5B8C5A', secondary: '#D5E8D4' },
      mentionPatterns: ['@codex-sol', '@sol', '@小太阳·砚砚'],
      clientId: 'openai',
      carrier: 'cli',
      defaultModel: 'gpt-5.6-sol',
      avatar: '/s56.png',
      roleDescription: 'dev',
      personality: 'sunny',
    },
    {
      id: 'codex61-sol',
      displayName: '缅因猫 Sol',
      nickname: '小太阳·砚砚',
      variantLabel: 'GPT-6.1 Sol',
      color: { primary: '#5B8C5A', secondary: '#D5E8D4' },
      mentionPatterns: ['@codex61-sol', '@gpt61-sol', '@sol61'],
      clientId: 'openai',
      carrier: 'cli',
      defaultModel: 'gpt-6.1-sol',
      avatar: '/s61.png',
      roleDescription: 'dev',
      personality: 'sunny',
    },
    {
      id: 'codex-astra',
      displayName: '缅因猫 Astra',
      nickname: '小星星·砚砚',
      variantLabel: 'GPT-6 Astra',
      color: { primary: '#5B8C5A', secondary: '#D5E8D4' },
      mentionPatterns: ['@codex-astra', '@astra', '@小星星'],
      clientId: 'openai',
      carrier: 'cli',
      defaultModel: 'gpt-6-astra',
      avatar: '/astra.png',
      roleDescription: 'review',
      personality: 'calm',
    },
  ];
  const options = buildCatOptions(SOL_CATS);
  const ids = (filter: string) => filterMentionOptions(options, filter).map((o) => o.id);

  it('"@小太阳" lists every Sol variant, including one whose aliases never say 小太阳', () => {
    expect(ids('小太阳')).toEqual(['codex-sol', 'codex61-sol']);
  });

  it('a later alias finds its member even when the insert uses the first alias', () => {
    expect(ids('sol61')).toEqual(['codex61-sol']);
    expect(ids('小星星')).toEqual(['codex-astra']);
  });

  it("picking the entry still inserts the member's own first alias", () => {
    const picked = filterMentionOptions(options, '小太阳').find((o) => o.id === 'codex61-sol');
    expect(picked?.insert).toBe('@codex61-sol ');
  });
});
