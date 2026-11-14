import { describe, expect, it } from 'vitest';
import { parseContentDirectionTargets, parseDirection, parseImplicitStructuredTargets } from '../parse-direction';

// Minimal mock: alias (lowercase, no @) → catId
const mockToCat: Record<string, string> = {
  opus: 'opus',
  布偶猫: 'opus',
  codex: 'codex',
  缅因猫: 'codex',
  gpt52: 'gpt52',
};

// Mock regex matching the same aliases (case-insensitive, boundary-aware)
const aliases = Object.keys(mockToCat).sort((a, b) => b.length - a.length);
const mockRe = new RegExp(`@(${aliases.join('|')})(?=$|\\s|[,.:;!?])`, 'gi');

const getMocks = () => ({ toCat: mockToCat, re: mockRe });

describe('parseDirection', () => {
  it('returns null for stream origin messages', () => {
    const msg = { origin: 'stream' as const, content: '@codex hi' };
    expect(parseDirection(msg, getMocks)).toBeNull();
  });

  it('parses single @mention from callback content', () => {
    const msg = { origin: 'callback' as const, content: 'R2 修复确认\n\n@codex' };
    expect(parseDirection(msg, getMocks)).toEqual({
      type: 'mention',
      targets: ['codex'],
      arrow: '→',
    });
  });

  it('parses multiple distinct @mentions', () => {
    const msg = { origin: 'callback' as const, content: '通知\n@codex\n@gpt52' };
    const result = parseDirection(msg, getMocks);
    expect(result?.type).toBe('mention');
    expect(result?.targets).toContain('codex');
    expect(result?.targets).toContain('gpt52');
    expect(result?.targets).toHaveLength(2);
  });

  it('deduplicates same cat from different aliases', () => {
    const msg = { origin: 'callback' as const, content: '@codex @缅因猫' };
    expect(parseDirection(msg, getMocks)).toEqual({
      type: 'mention',
      targets: ['codex'],
      arrow: '→',
    });
  });

  it('parses crossPost direction from extra metadata', () => {
    const msg = {
      origin: 'callback' as const,
      content: 'cross post content',
      extra: { crossPost: { sourceThreadId: 'thread_abc12345xyz' } },
    };
    expect(parseDirection(msg, getMocks, 'thread_target')).toEqual({
      type: 'crossPost',
      targets: ['abc12345'],
      arrow: '↗',
    });
  });

  it('does not render legacy self-referential crossPost metadata as a cross-thread direction', () => {
    const msg = {
      origin: 'callback' as const,
      content: 'same-thread coordination callback',
      extra: { crossPost: { sourceThreadId: 'thread_same' } },
    };
    expect(parseDirection(msg, getMocks, 'thread_same')).toBeNull();
  });

  it('parses whisper direction from whisperTo (highest priority)', () => {
    const msg = {
      visibility: 'whisper' as const,
      whisperTo: ['codex', 'gpt52'],
      content: '@opus secret',
    };
    expect(parseDirection(msg, getMocks)).toEqual({
      type: 'whisper',
      targets: ['codex', 'gpt52'],
      arrow: '→',
    });
  });

  it('returns null for callback with no recognized @mention', () => {
    const msg = { origin: 'callback' as const, content: 'general broadcast to all' };
    expect(parseDirection(msg, getMocks)).toBeNull();
  });

  it('returns null for messages with no origin and no whisper', () => {
    const msg = { content: 'hello world' };
    expect(parseDirection(msg, getMocks)).toBeNull();
  });

  it('parses targets from connector source.meta (F098-C2 multi_mention)', () => {
    const msg = {
      content: '## Multi-Mention 结果汇总',
      source: {
        connector: 'multi-mention-result',
        meta: { initiator: 'opus', targets: ['codex', 'gpt52', 'gemini'] },
      },
    };
    const result = parseDirection(msg, getMocks);
    expect(result).toEqual({
      type: 'mention',
      targets: ['codex', 'gpt52', 'gemini'],
      arrow: '→',
    });
  });

  it('connector source.meta.targets takes priority over content @mention parsing', () => {
    const msg = {
      origin: 'callback' as const,
      content: '@codex some content',
      source: {
        connector: 'multi-mention-result',
        meta: { targets: ['codex', 'gpt52'] },
      },
    };
    const result = parseDirection(msg, getMocks);
    // Should use meta.targets, not content parsing
    expect(result?.targets).toEqual(['codex', 'gpt52']);
  });

  it('uses extra.targetCats when present (F098-C1)', () => {
    const msg = {
      origin: 'callback' as const,
      content: 'Review done',
      extra: { targetCats: ['codex', 'gpt52'] },
    };
    const result = parseDirection(msg, getMocks);
    expect(result).toEqual({
      type: 'mention',
      targets: ['codex', 'gpt52'],
      arrow: '→',
    });
  });

  it('extra.targetCats takes priority over content @mention parsing (F098-C1)', () => {
    const msg = {
      origin: 'callback' as const,
      content: '@codex some content',
      extra: { targetCats: ['gpt52'] },
    };
    const result = parseDirection(msg, getMocks);
    expect(result?.targets).toEqual(['gpt52']);
  });

  it('filters out __co-creator__ pseudo-cat from @mention results (P1-2)', () => {
    // getMentionToCat maps @co-creator/@co-creator to __co-creator__ — must not leak into UI
    const ownerToCat: Record<string, string> = {
      ...mockToCat,
      operator: '__co-creator__',
      'co-creator': '__co-creator__',
    };
    const ownerAliases = Object.keys(ownerToCat).sort((a, b) => b.length - a.length);
    const ownerRe = new RegExp(`@(${ownerAliases.join('|')})(?=$|\\s|[,.:;!?])`, 'gi');
    const getOwnerMocks = () => ({ toCat: ownerToCat, re: ownerRe });

    // Only @co-creator → should return null (owner filtered out)
    const msg1 = { origin: 'callback' as const, content: '通知co-creator\n@co-creator' };
    expect(parseDirection(msg1, getOwnerMocks)).toBeNull();

    // A line that opens with the owner's handle routes no cat in the API grammar, so no badge either.
    const msg2 = { origin: 'callback' as const, content: '@co-creator @codex' };
    expect(parseDirection(msg2, getOwnerMocks)).toBeNull();

    // The owner on one line, a cat on the next: only the cat routes.
    const msg3 = { origin: 'callback' as const, content: '@co-creator\n@codex' };
    expect(parseDirection(msg3, getOwnerMocks)?.targets).toEqual(['codex']);
  });
});

/**
 * F314-17: the badge must show what the API routes (analyzeA2AMentions), not every handle in the text.
 * The first four inputs are the F314 report's reproduction with an opus/codex roster.
 */
describe('direction badge follows the API A2A grammar', () => {
  const callback = (content: string, catId?: string) => ({ origin: 'callback' as const, content, catId });

  it('a mention inside prose is not a routing target', () => {
    expect(parseDirection(callback('ask @opus in prose'), getMocks)).toBeNull();
  });

  it('a mention after prose starts on the line does not route', () => {
    expect(parseDirection(callback('@opus 请继续，如果需要再找 @codex'), getMocks)?.targets).toEqual(['opus']);
    expect(parseContentDirectionTargets('@opus 请继续，如果需要再找 @codex', getMocks)).toEqual(['opus']);
  });

  it('a mention inside a fenced code block does not route', () => {
    expect(parseDirection(callback('```\n@opus\n```'), getMocks)).toBeNull();
  });

  it('a CJK character right after the handle still routes', () => {
    expect(parseDirection(callback('@opus请继续'), getMocks)?.targets).toEqual(['opus']);
  });

  it('the sender never routes to itself', () => {
    expect(parseDirection(callback('@opus\n@codex', 'opus'), getMocks)?.targets).toEqual(['codex']);
  });

  it('keeps at most two targets, like the API', () => {
    expect(parseDirection(callback('@opus @codex @gpt52'), getMocks)?.targets).toEqual(['opus', 'codex']);
  });

  it('matches a disabled member and then drops it, so the next handle on the line still routes (F182 KD-10)', () => {
    const withDisabled = () => ({ ...getMocks(), unavailableToCat: { antigravity: 'antigravity' } });
    expect(parseDirection(callback('@antigravity @codex', 'kimi'), withDisabled)?.targets).toEqual(['codex']);
    expect(parseDirection(callback('@antigravity @opus @codex', 'kimi'), withDisabled)?.targets).toEqual([
      'opus',
      'codex',
    ]);
    expect(parseDirection(callback('@antigravity', 'kimi'), withDisabled)).toBeNull();
  });
});

describe('post_message structured target projection', () => {
  it('matches only actionable line-start mentions', () => {
    expect(parseContentDirectionTargets('ask @opus in prose\n- @codex\n> @gpt52', getMocks)).toEqual([
      'codex',
      'gpt52',
    ]);
  });

  it('projects only structured targets not already visible in the body', () => {
    const msg = {
      origin: 'callback' as const,
      content: '@opus\n@codex\n@gpt52',
      extra: { isExplicitPost: true, targetCats: ['gpt52', 'new-cat', 'new-cat'] },
    };
    expect(parseImplicitStructuredTargets(msg, getMocks)).toEqual(['new-cat']);
  });

  it('projects structured targets even when callback settlement omits the standalone-post marker', () => {
    const msg = {
      origin: 'callback' as const,
      content: 'ordinary callback',
      extra: { targetCats: ['opus'] },
    };
    expect(parseImplicitStructuredTargets(msg, getMocks)).toEqual(['opus']);
  });
});
