/**
 * F208 Phase C: formatModelName regression tests.
 *
 * P2 cloud review finding — the original implementation assumed all Claude models
 * had exactly 2 trailing version segments (e.g. "claude-opus-4-6"). Models like
 * "claude-fable-5" (1 segment) and "claude-opus-4-5-20251101" (3 segments) were
 * garbled. The fix detects version start by first numeric segment.
 *
 * Cloud round 2 P2: test must import the PRODUCTION function, not a local copy.
 */
import { describe, expect, it } from 'vitest';
import { formatModelName } from '../CatDossierContent';

describe('formatModelName (P2 regression — variable segment counts)', () => {
  // Standard 3-segment Claude models
  it('claude-opus-4-6 → Claude Opus 4.6', () => {
    expect(formatModelName('claude-opus-4-6')).toBe('Claude Opus 4.6');
  });

  it('claude-sonnet-4-6 → Claude Sonnet 4.6', () => {
    expect(formatModelName('claude-sonnet-4-6')).toBe('Claude Sonnet 4.6');
  });

  it('claude-opus-4-7 → Claude Opus 4.7', () => {
    expect(formatModelName('claude-opus-4-7')).toBe('Claude Opus 4.7');
  });

  // P2 regression target: 2-segment model (single version number)
  it('claude-fable-5 → Claude Fable 5 (not "Claude  fable.5")', () => {
    expect(formatModelName('claude-fable-5')).toBe('Claude Fable 5');
  });

  // P2 regression target: 4-segment model (version + date suffix)
  it('claude-opus-4-5-20251101 → Claude Opus 4.5.20251101', () => {
    expect(formatModelName('claude-opus-4-5-20251101')).toBe('Claude Opus 4.5.20251101');
  });

  // GPT models
  it('gpt-5.4 → GPT 5.4', () => {
    expect(formatModelName('gpt-5.4')).toBe('GPT 5.4');
  });

  // Gemini models
  it('gemini-3.1-pro → Gemini 3.1 Pro', () => {
    expect(formatModelName('gemini-3.1-pro')).toBe('Gemini 3.1 Pro');
  });

  // Edge cases
  it('unknown → 未知模型', () => {
    expect(formatModelName('unknown')).toBe('未知模型');
  });

  it('empty string → 未知模型', () => {
    expect(formatModelName('')).toBe('未知模型');
  });

  it('passthrough for unrecognized prefix', () => {
    expect(formatModelName('kimi-code/kimi-for-coding')).toBe('kimi-code/kimi-for-coding');
  });
});
