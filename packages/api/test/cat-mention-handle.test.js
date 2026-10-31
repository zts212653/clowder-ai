// @ts-check
/**
 * F128 — normalize @<catId> tokens in user-typed text to @<stable-handle>
 * so AgentRouter.parseAllMentions can recognise them downstream.
 *
 * Why: cats sometimes write `@cat-rcs85pvn` in `initialMessage` (carried
 * over from cat_cafe_get_thread_cats output). Router only knows configured
 * mentionPatterns; raw catId tokens aren't matched. Normalising at the
 * propose boundary aligns thread text with how the cat would have written
 * mentions in the same thread (e.g. `@砚砚`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { normalizeCatIdMentionsInText } = await import('../dist/utils/cat-mention-handle.js');

// Test-only resolver simulating a populated catRegistry. Real production uses
// `primaryMentionHandleForCatId` which reads the live catRegistry.
function makeResolver(map) {
  return (token) => map[token] ?? null;
}

describe('normalizeCatIdMentionsInText (F128 propose-text normalization)', () => {
  it('replaces @cat-XXX with the cat primary stable handle', () => {
    const resolve = makeResolver({
      'cat-rcs85pvn': '@砚砚',
      'cat-g820pwcz': '@opus46',
    });
    const input = '下一棒 @cat-rcs85pvn 然后第三棒 @cat-g820pwcz';
    const out = normalizeCatIdMentionsInText(input, resolve);
    assert.equal(out, '下一棒 @砚砚 然后第三棒 @opus46');
  });

  it('leaves @<token> unchanged when the token does not resolve', () => {
    const resolve = makeResolver({}); // empty registry → no resolution
    const input = '请 @co-creator 决定，并 @cat-unknown 跟踪';
    const out = normalizeCatIdMentionsInText(input, resolve);
    assert.equal(out, input, 'unresolvable tokens must be passed through verbatim');
  });

  it('leaves already-stable handles (no catId substring) unchanged', () => {
    const resolve = makeResolver({
      'cat-rcs85pvn': '@砚砚',
    });
    const input = '@砚砚 接龙下一棒';
    const out = normalizeCatIdMentionsInText(input, resolve);
    assert.equal(out, '@砚砚 接龙下一棒', 'pre-stabilized mentions stay verbatim');
  });

  it('does not mangle email addresses or non-@ uses', () => {
    const resolve = makeResolver({ 'cat-rcs85pvn': '@砚砚' });
    const input = 'send to alice@example.com about cat-rcs85pvn (no @ prefix)';
    const out = normalizeCatIdMentionsInText(input, resolve);
    // Plain `cat-rcs85pvn` without @ stays. email's `@example.com` is parsed
    // as a token but not in resolver → left as-is.
    assert.equal(out, input);
  });

  it('handles multi-line messages with multiple @-mentions', () => {
    const resolve = makeResolver({
      'cat-rcs85pvn': '@砚砚',
      'cat-g820pwcz': '@opus46',
    });
    const input = ['顺序:', '1. @cat-rcs85pvn', '2. @cat-g820pwcz', '3. 回到co-creator'].join('\n');
    const out = normalizeCatIdMentionsInText(input, resolve);
    assert.equal(out, ['顺序:', '1. @砚砚', '2. @opus46', '3. 回到co-creator'].join('\n'));
  });

  it('handles repeated mention of the same catId', () => {
    const resolve = makeResolver({ 'cat-rcs85pvn': '@砚砚' });
    const input = '@cat-rcs85pvn 接 → @cat-rcs85pvn 再接';
    const out = normalizeCatIdMentionsInText(input, resolve);
    assert.equal(out, '@砚砚 接 → @砚砚 再接');
  });

  it('returns input unchanged when no @-mentions are present', () => {
    const resolve = makeResolver({ 'cat-rcs85pvn': '@砚砚' });
    const input = '开玩！我先起头：一帆风顺';
    const out = normalizeCatIdMentionsInText(input, resolve);
    assert.equal(out, input);
  });
});
