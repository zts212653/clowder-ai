import { describe, expect, it } from 'vitest';
import {
  getCliEffortOptionsForProvider,
  getDefaultCliEffortForProvider,
  inferGoogleModelEffort,
  isValidCliEffortForProvider,
  normalizeCliEffortForProvider,
  normalizeModelSlug,
  resolveCliEffortOverride,
} from '../cli-effort.js';

describe('CLI effort capabilities', () => {
  it('exposes the effort tiers supported by each OpenAI model', () => {
    expect(getCliEffortOptionsForProvider('openai', 'gpt-5.6-sol')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    expect(getCliEffortOptionsForProvider('openai', 'openai/gpt-5.6-terra')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    expect(getCliEffortOptionsForProvider('openai', 'gpt-5.6')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    expect(getCliEffortOptionsForProvider('openai', 'gpt-5.6-luna')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(getCliEffortOptionsForProvider('openai', 'gpt-6-astra')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    expect(getCliEffortOptionsForProvider('openai', 'openai/gpt-6-sol')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    expect(getCliEffortOptionsForProvider('openai', 'gpt-6-luna')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(getCliEffortOptionsForProvider('openai', 'gpt-5.5')).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(getCliEffortOptionsForProvider('openai', 'gpt-5.6-unknown')).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(getCliEffortOptionsForProvider('openai', 'gpt-6-unknown')).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(getCliEffortOptionsForProvider('openai')).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('keeps maintained preset validation model-aware while preserving native member values', () => {
    expect(isValidCliEffortForProvider('openai', 'ultra', 'gpt-5.6-sol')).toBe(true);
    expect(isValidCliEffortForProvider('openai', 'max', 'gpt-5.6-sol')).toBe(true);
    expect(isValidCliEffortForProvider('openai', 'max', 'gpt-5.6-luna')).toBe(true);
    expect(isValidCliEffortForProvider('openai', 'ultra', 'gpt-5.6-luna')).toBe(false);
    expect(isValidCliEffortForProvider('openai', 'max', 'gpt-6-astra')).toBe(true);
    expect(isValidCliEffortForProvider('openai', 'ultra', 'gpt-6-sol')).toBe(true);
    expect(isValidCliEffortForProvider('openai', 'max', 'gpt-6-luna')).toBe(true);
    expect(isValidCliEffortForProvider('openai', 'ultra', 'gpt-6-luna')).toBe(false);
    expect(isValidCliEffortForProvider('openai', 'ultra', 'gpt-5.5')).toBe(false);
    expect(isValidCliEffortForProvider('openai', 'turbo-native', 'gpt-5.6-sol')).toBe(false);
    expect(normalizeCliEffortForProvider('openai', ' turbo-native ', 'gpt-5.5')).toBe('turbo-native');
    expect(normalizeCliEffortForProvider('google', 'turbo-native', 'gemini-3.1-pro')).toBeNull();
  });

  it('exposes Kimi effort options only for tier-capable k3 models', () => {
    // kimi-code config.toml: k3 family declares support_efforts=[low,high,max];
    // kimi-for-coding / k2.x are boolean-thinking models with no tier metadata.
    expect(getCliEffortOptionsForProvider('kimi', 'kimi-code/k3')).toEqual(['low', 'high', 'max']);
    expect(getCliEffortOptionsForProvider('kimi', 'kimi-code/k3-256k')).toEqual(['low', 'high', 'max']);
    expect(getCliEffortOptionsForProvider('kimi', 'kimi-code/kimi-for-coding')).toBeNull();
    expect(getCliEffortOptionsForProvider('kimi', 'kimi-k2.5')).toBeNull();
    expect(getCliEffortOptionsForProvider('kimi')).toBeNull();
    expect(getDefaultCliEffortForProvider('kimi')).toBe('high');
    expect(isValidCliEffortForProvider('kimi', 'max', 'kimi-code/k3')).toBe(true);
    expect(isValidCliEffortForProvider('kimi', 'medium', 'kimi-code/k3')).toBe(false);
    expect(isValidCliEffortForProvider('kimi', 'max', 'kimi-code/kimi-for-coding')).toBe(false);
    expect(normalizeCliEffortForProvider('kimi', undefined)).toBe('high');
    expect(normalizeCliEffortForProvider('kimi', ' max ')).toBe('max');
  });

  it('resolves a compatible Kimi thread override above the inherited effort', () => {
    expect(resolveCliEffortOverride('kimi', 'kimi-code/k3', 'high', 'max')).toEqual({
      effective: 'max',
      source: 'thread_override',
      compatibility: 'compatible',
    });
    expect(resolveCliEffortOverride('kimi', 'kimi-code/k3', 'high', 'medium' as never)).toEqual({
      effective: 'high',
      source: 'inherited',
      compatibility: 'incompatible',
    });
  });

  it('normalizes provider-prefixed and bare model identifiers to the same slug', () => {
    expect(normalizeModelSlug('gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(normalizeModelSlug('openai/gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(normalizeModelSlug(' OpenAI/GPT-5.6-SOL ')).toBe('gpt-5.6-sol');
  });

  it('keeps Anthropic effort options unchanged', () => {
    expect(getCliEffortOptionsForProvider('anthropic', 'claude-opus-4-6')).toEqual(['low', 'medium', 'high', 'max']);
  });

  it('exposes xhigh effort options and suffix inference for Gemini 4 Neon and Hydrogen', () => {
    for (const model of [
      'gemini-4-neon',
      'gemini-4-neon-low',
      'gemini-4-neon-medium',
      'gemini-4-neon-high',
      'gemini-4-neon-xhigh',
      'Gemini 4 Neon (XHigh)',
      'Gemini 4 Neon (High)',
      'gemini-4-hydrogen-xhigh',
    ]) {
      expect(getCliEffortOptionsForProvider('google', model)).toEqual(['low', 'medium', 'high', 'xhigh']);
      expect(isValidCliEffortForProvider('google', 'xhigh', model)).toBe(true);
      expect(isValidCliEffortForProvider('google', 'max', model)).toBe(false);
    }
    expect(normalizeCliEffortForProvider('google', 'xhigh', 'gemini-4-neon-high')).toBe('xhigh');
    expect(inferGoogleModelEffort('gemini-4-neon-xhigh')).toBe('xhigh');
    expect(inferGoogleModelEffort('Gemini 4 Neon (XHigh)')).toBe('xhigh');
    expect(inferGoogleModelEffort('gemini-4-argon-high')).toBe('high');
    expect(inferGoogleModelEffort('gemini-4-neon')).toBeNull();
    expect(inferGoogleModelEffort('gemini-4-argon-xhigh')).toBeNull();
    expect(resolveCliEffortOverride('google', 'gemini-4-neon-high', 'high', 'xhigh')).toEqual({
      effective: 'xhigh',
      source: 'thread_override',
      compatibility: 'compatible',
    });
  });

  it('resolves a compatible thread override above the inherited effort', () => {
    expect(resolveCliEffortOverride('openai', 'gpt-5.6-sol', 'xhigh', 'max')).toEqual({
      effective: 'max',
      source: 'thread_override',
      compatibility: 'compatible',
    });
  });

  it('projects absence as compatible inheritance without persisting a copy', () => {
    expect(resolveCliEffortOverride('anthropic', 'claude-opus-4-6', 'high', null)).toEqual({
      effective: 'high',
      source: 'inherited',
      compatibility: 'compatible',
    });
    expect(resolveCliEffortOverride('anthropic', 'claude-opus-4-6', 'high', undefined)).toEqual({
      effective: 'high',
      source: 'inherited',
      compatibility: 'compatible',
    });
  });

  it('retains stale intent outside the resolver while failing closed to inheritance', () => {
    expect(resolveCliEffortOverride('openai', 'gpt-5.4', 'xhigh', 'ultra')).toEqual({
      effective: 'xhigh',
      source: 'inherited',
      compatibility: 'incompatible',
    });
    expect(resolveCliEffortOverride('openai', 'gpt-5.6-sol', 'xhigh', 'ultra')).toEqual({
      effective: 'ultra',
      source: 'thread_override',
      compatibility: 'compatible',
    });
    expect(
      resolveCliEffortOverride('openai', 'gpt-5.6-sol', 'turbo-native' as never, 'future-thread-value' as never),
    ).toEqual({
      effective: 'turbo-native',
      source: 'inherited',
      compatibility: 'incompatible',
    });
  });
});
