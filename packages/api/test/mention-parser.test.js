import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseMentions } from '../dist/infrastructure/connectors/mention-parser.js';

// P1-4: @宪宪/@砚砚 removed from breeds → patterns aligned with cat-template.json
const allPatterns = new Map([
  ['opus', ['@opus', '@布偶猫', '@布偶', '@ragdoll']],
  ['codex', ['@codex', '@缅因猫', '@缅因', '@maine']],
  ['gemini', ['@gemini', '@暹罗猫', '@暹罗', '@烁烁']],
]);

describe('parseMentions', () => {
  it('returns matched catId for @opus', () => {
    const result = parseMentions('@opus hello', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'opus');
  });

  it('returns matched catId for @缅因猫', () => {
    const result = parseMentions('@缅因猫 请review', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'codex');
  });

  // P1-4: @砚砚 removed → use @maine (still valid codex alias)
  it('returns matched catId for @maine (alias)', () => {
    const result = parseMentions('@maine 你看看这个', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'codex');
  });

  it('returns defaultCatId when no mention found', () => {
    const result = parseMentions('hello world', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'opus');
  });

  it('matches mention anywhere in text', () => {
    const result = parseMentions('hey @codex check this', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'codex');
  });

  it('returns first match when multiple cats mentioned', () => {
    const result = parseMentions('@codex @gemini hello', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'codex');
  });

  it('is case-insensitive for English patterns', () => {
    const result = parseMentions('@OPUS hello', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'opus');
  });

  it('does not match partial words like @opusxyz', () => {
    const result = parseMentions('@opusxyz hello', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'opus'); // default, not matched
  });

  it('matches @mention at end of text', () => {
    const result = parseMentions('please review @codex', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'codex');
  });

  it('matches @mention followed by punctuation', () => {
    const result = parseMentions('@gemini, 看看这个', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'gemini');
  });

  it('returns default when patterns map is empty', () => {
    const result = parseMentions('@opus hello', new Map(), 'opus');
    assert.equal(result.targetCatId, 'opus');
  });

  // P1-1: CJK full-width punctuation after mention
  it('matches @mention followed by Chinese full-width comma', () => {
    const result = parseMentions('@缅因猫，看下这个', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'codex');
  });

  it('matches @mention followed by Chinese full-width period', () => {
    const result = parseMentions('@布偶猫。你好', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'opus');
  });

  it('matches @mention followed by Chinese full-width exclamation', () => {
    const result = parseMentions('@缅因猫！快来', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'codex');
  });

  it('matches @mention followed by Chinese full-width question mark', () => {
    const result = parseMentions('@烁烁？你在吗', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'gemini');
  });

  // P1-2: first-in-text mention wins, not first-in-map
  it('returns first mention by text position, not map iteration order', () => {
    // gemini appears first in text, codex second — gemini should win
    const result = parseMentions('@gemini hi @codex', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'gemini');
  });

  it('returns first mention by text position with CJK patterns', () => {
    // 暹罗猫 appears before 布偶猫 in text
    const result = parseMentions('请 @暹罗猫 和 @布偶猫 一起看', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'gemini');
  });

  // R2-P1: email/domain false positive — left boundary constraint
  it('does not match @codex inside email address', () => {
    const result = parseMentions('请发到 foo@codex.com 再看', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'opus'); // default, not codex
  });

  it('does not match @opus inside domain-like string', () => {
    // Use codex as default to distinguish false match from default
    const result = parseMentions('visit site@opus.dev for details', allPatterns, 'codex');
    assert.equal(result.targetCatId, 'codex'); // default codex, not opus
  });

  it('still matches @codex at start of text (left boundary = BOL)', () => {
    const result = parseMentions('@codex check this', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'codex');
  });

  it('still matches @codex after CJK text without space', () => {
    // In CJK writing, there's often no space before @mention
    const result = parseMentions('帮忙看看@codex', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'codex');
  });

  // Cloud-R1-P1: period directly before @mention should still match
  it('matches @codex after sentence-ending period without space', () => {
    const result = parseMentions('ok.@codex please', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'codex');
  });

  // Cloud-R2-P2: bracket punctuation after mention
  it('matches @codex wrapped in parentheses', () => {
    const result = parseMentions('(@codex) ping', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'codex');
  });

  it('matches @codex followed by closing bracket', () => {
    const result = parseMentions('see [@codex]', allPatterns, 'opus');
    assert.equal(result.targetCatId, 'codex');
  });
});
