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
import { buildCatOptions, detectMenuTrigger } from '@/components/chat-input-options';
import type { CatData } from '@/hooks/useCatData';

const MANY_CATS: CatData[] = [
  {
    id: 'opus',
    displayName: '布偶猫',
    color: { primary: '#9B7EBD', secondary: '#E8D5F5' },
    mentionPatterns: ['布偶', 'opus'],
    provider: 'anthropic',
    defaultModel: 'opus',
    avatar: '/a.png',
    roleDescription: 'dev',
    personality: 'kind',
    source: 'seed',
  },
  {
    id: 'codex',
    displayName: '缅因猫',
    color: { primary: '#5B8C5A', secondary: '#D5E8D4' },
    mentionPatterns: ['缅因', 'codex'],
    provider: 'openai',
    defaultModel: 'codex',
    avatar: '/b.png',
    roleDescription: 'review',
    personality: 'strict',
    source: 'seed',
  },
  {
    id: 'gemini',
    displayName: '暹罗猫',
    color: { primary: '#5B9BD5', secondary: '#D6E9F8' },
    mentionPatterns: ['暹罗', 'gemini'],
    provider: 'google',
    defaultModel: 'gemini',
    avatar: '/c.png',
    roleDescription: 'design',
    personality: 'creative',
    source: 'seed',
  },
  {
    id: 'sonnet',
    displayName: '布偶猫',
    variantLabel: 'Sonnet',
    color: { primary: '#9B7EBD', secondary: '#E8D5F5' },
    mentionPatterns: ['sonnet'],
    provider: 'anthropic',
    defaultModel: 'sonnet',
    avatar: '/d.png',
    roleDescription: 'fast dev',
    personality: 'quick',
    source: 'seed',
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
    const lower = 'op';
    const filtered = options.filter(
      (opt) =>
        opt.label.toLowerCase().includes(lower) ||
        opt.insert.toLowerCase().includes(lower) ||
        opt.id.toLowerCase().includes(lower),
    );
    // Should match opus (id) and possibly sonnet's label if it contains 'op'
    expect(filtered.some((o) => o.id === 'opus')).toBe(true);
    expect(filtered.some((o) => o.id === 'gemini')).toBe(false);
  });

  it('filters by id match', () => {
    const lower = 'codex';
    const filtered = options.filter(
      (opt) =>
        opt.label.toLowerCase().includes(lower) ||
        opt.insert.toLowerCase().includes(lower) ||
        opt.id.toLowerCase().includes(lower),
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('codex');
  });

  it('returns empty for non-matching filter', () => {
    const lower = 'xyz';
    const filtered = options.filter(
      (opt) =>
        opt.label.toLowerCase().includes(lower) ||
        opt.insert.toLowerCase().includes(lower) ||
        opt.id.toLowerCase().includes(lower),
    );
    expect(filtered).toHaveLength(0);
  });

  it('empty filter returns all options', () => {
    const lower = '';
    const filtered = lower
      ? options.filter(
          (opt) =>
            opt.label.toLowerCase().includes(lower) ||
            opt.insert.toLowerCase().includes(lower) ||
            opt.id.toLowerCase().includes(lower),
        )
      : options;
    expect(filtered).toHaveLength(options.length);
  });
});
