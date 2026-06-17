import { describe, expect, it } from 'vitest';
import type { ProfileItem } from '@/components/hub-accounts.types';
import { buildCallHint, KNOWN_OC_PROVIDERS, resolveOpenCodeEndpoint } from '@/components/hub-cat-editor.sections';

/** Minimal profile stub for buildCallHint tests */
function mkProfile(baseUrl: string): ProfileItem {
  return {
    id: 't',
    displayName: '',
    name: '',
    authType: 'api_key',
    kind: 'api_key',
    builtin: false,
    mode: 'api_key',
    clientId: 'opencode',
    baseUrl,
    hasApiKey: true,
    createdAt: '2026-06-11T00:00:00.000Z',
    updatedAt: '2026-06-11T00:00:00.000Z',
  };
}

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

describe('buildCallHint — API version URL display (#886)', () => {
  it('base ending /v1 avoids /v1/v1 duplication', () => {
    const hint = buildCallHint('opencode', mkProfile('https://api.example.com/v1'), 'gpt-4', 'openai');
    expect(hint?.url).toBe('https://api.example.com/v1/chat/completions');
  });

  it('base ending /v2 produces /v2/chat/completions, not /v2/v1/chat/completions', () => {
    const hint = buildCallHint('opencode', mkProfile('https://maas-api.cn-huabei-1.xf-yun.com/v2'), 'spark', 'maas');
    expect(hint?.url).toBe('https://maas-api.cn-huabei-1.xf-yun.com/v2/chat/completions');
  });

  it('base without version appends full /v1 suffix', () => {
    const hint = buildCallHint('opencode', mkProfile('https://api.example.com'), 'gpt-4', 'openai');
    expect(hint?.url).toBe('https://api.example.com/v1/chat/completions');
  });

  it('trailing slash in base is stripped', () => {
    const hint = buildCallHint('opencode', mkProfile('https://api.example.com/v2/'), 'spark', 'maas');
    expect(hint?.url).toBe('https://api.example.com/v2/chat/completions');
  });

  it('google endpoint with /v1 base does not strip version', () => {
    const hint = buildCallHint('google', mkProfile('https://gateway.example.com/v1'), 'gemini-pro', 'google');
    expect(hint?.url).toBe('https://gateway.example.com/v1/models/gemini-pro:generateContent');
  });

  it('non-opencode clients keep their runtime /v1 suffix after non-v1 base URLs', () => {
    const hint = buildCallHint('anthropic', mkProfile('https://gateway.example.com/v2'), 'claude-sonnet', 'anthropic');
    expect(hint?.url).toBe('https://gateway.example.com/v2/v1/messages');
  });
});
