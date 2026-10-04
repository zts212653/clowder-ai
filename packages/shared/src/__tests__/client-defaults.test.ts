import { describe, expect, it } from 'vitest';
import { type ClientDefaultsEntry, resolveClientDefaults } from '../types/client-defaults.js';

const entry = (defaultModel: string): ClientDefaultsEntry => ({ defaultModel, models: [defaultModel] });

describe('resolveClientDefaults (#768 P3)', () => {
  it('resolves canonical ClientId keys', () => {
    const defaults = { anthropic: entry('claude-sonnet-4-6'), antigravity: entry('gemini-3.1-pro') };
    expect(resolveClientDefaults(defaults, 'anthropic')?.defaultModel).toBe('claude-sonnet-4-6');
    expect(resolveClientDefaults(defaults, 'antigravity')?.defaultModel).toBe('gemini-3.1-pro');
  });

  it('still reads legacy product-name keys from templates written before #768', () => {
    const legacy = { claude: entry('claude-sonnet-4-6'), codex: entry('gpt-5.4'), gemini: entry('Gemini 3.1 Pro') };
    expect(resolveClientDefaults(legacy, 'anthropic')?.defaultModel).toBe('claude-sonnet-4-6');
    expect(resolveClientDefaults(legacy, 'openai')?.defaultModel).toBe('gpt-5.4');
    expect(resolveClientDefaults(legacy, 'google')?.defaultModel).toBe('Gemini 3.1 Pro');
  });

  it('accepts builtin_* account refs as keys (same identity table)', () => {
    expect(resolveClientDefaults({ builtin_kimi: entry('kimi-for-coding') }, 'kimi')?.defaultModel).toBe(
      'kimi-for-coding',
    );
  });

  it('prefers the canonical key when a template carries both spellings', () => {
    const mixed = { anthropic: entry('claude-opus-4-6'), claude: entry('claude-sonnet-4-6') };
    expect(resolveClientDefaults(mixed, 'anthropic')?.defaultModel).toBe('claude-opus-4-6');
  });

  it('returns null instead of guessing when the client has no entry', () => {
    expect(resolveClientDefaults({ anthropic: entry('claude-sonnet-4-6') }, 'opencode')).toBeNull();
    expect(resolveClientDefaults({}, 'anthropic')).toBeNull();
    expect(resolveClientDefaults(undefined, 'anthropic')).toBeNull();
    expect(resolveClientDefaults(null, 'anthropic')).toBeNull();
  });

  it('does not map an unrelated legacy key onto a different client', () => {
    // `claude` is the anthropic CLI name — it must not answer for openai.
    expect(resolveClientDefaults({ claude: entry('claude-sonnet-4-6') }, 'openai')).toBeNull();
  });
});
