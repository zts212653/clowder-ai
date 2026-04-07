import { describe, expect, it } from 'vitest';
import { KNOWN_OC_PROVIDERS, resolveOpenCodeEndpoint } from '@/components/hub-cat-editor.sections';

describe('KNOWN_OC_PROVIDERS datalist suggestions', () => {
  it('includes openai-responses for Responses API users (#292)', () => {
    expect(KNOWN_OC_PROVIDERS).toContain('openai-responses');
  });

  it('includes core provider names', () => {
    for (const name of ['anthropic', 'openai', 'google', 'openrouter']) {
      expect(KNOWN_OC_PROVIDERS).toContain(name);
    }
  });

  it('derives endpoint solely from ocProviderName', () => {
    expect(resolveOpenCodeEndpoint('openai-responses')).toBe('/v1/responses');
    expect(resolveOpenCodeEndpoint('anthropic')).toBe('/v1/messages');
    expect(resolveOpenCodeEndpoint('google')).toBe('/models/{model}:generateContent');
    expect(resolveOpenCodeEndpoint('maas')).toBe('/v1/chat/completions');
  });
});
