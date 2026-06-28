// @ts-check

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { resolveEnvMap, extractUserEnvTemplates, BUILTIN_ENV_MAPS, OPENROUTER_COMPAT_ENV_ALIAS_CLIENTS } = await import(
  '../dist/domains/cats/services/agents/providers/env-map.js'
);

describe('F161: env-map — resolveEnvMap', () => {
  it('resolves anthropic built-in mapping', () => {
    const result = resolveEnvMap('anthropic', undefined, {
      apiKey: 'sk-ant-xxx',
      baseUrl: 'https://api.anthropic.com',
    });
    assert.deepEqual(result, {
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    });
  });

  it('resolves openai built-in mapping (with routing compat keys)', () => {
    const result = resolveEnvMap('openai', undefined, {
      apiKey: 'sk-xxx',
      baseUrl: 'https://api.openai.com',
    });
    assert.deepEqual(result, {
      OPENAI_API_KEY: 'sk-xxx',
      OPENROUTER_API_KEY: 'sk-xxx',
      OPENAI_BASE_URL: 'https://api.openai.com',
      OPENAI_API_BASE: 'https://api.openai.com',
    });
  });

  it('resolves google built-in mapping (triple key)', () => {
    const result = resolveEnvMap('google', undefined, {
      apiKey: 'AIza-xxx',
    });
    assert.deepEqual(result, {
      GEMINI_API_KEY: 'AIza-xxx',
      GOOGLE_API_KEY: 'AIza-xxx',
      OPENROUTER_API_KEY: 'AIza-xxx',
    });
  });

  it('documents the exact built-in clients that intentionally alias credentials to OPENROUTER_API_KEY', () => {
    assert.deepEqual([...OPENROUTER_COMPAT_ENV_ALIAS_CLIENTS], ['openai', 'google']);
    const aliasMaps = Object.entries(BUILTIN_ENV_MAPS)
      .filter(([client, envMap]) => client !== 'openrouter' && envMap.OPENROUTER_API_KEY === '${api_key}')
      .map(([client]) => client)
      .sort();
    assert.deepEqual(aliasMaps, ['google', 'openai']);
  });

  it('resolves openrouter via provider name (not clientId)', () => {
    // opencode cat with provider=openrouter
    const result = resolveEnvMap('opencode', 'openrouter', {
      apiKey: 'sk-or-xxx',
    });
    assert.deepEqual(result, {
      OPENROUTER_API_KEY: 'sk-or-xxx',
    });
  });

  it('resolves opencode built-in mapping (native env vars)', () => {
    const result = resolveEnvMap('opencode', undefined, {
      apiKey: 'sk-oc-xxx',
      baseUrl: 'https://proxy.example.com',
    });
    assert.deepEqual(result, {
      OPENCODE_API_KEY: 'sk-oc-xxx',
      OPENCODE_BASE_URL: 'https://proxy.example.com',
    });
  });

  it('provider takes priority over clientId', () => {
    // clientId=opencode has built-in map, but provider=anthropic overrides it
    const result = resolveEnvMap('opencode', 'anthropic', {
      apiKey: 'sk-ant-xxx',
      baseUrl: 'https://proxy.example.com',
    });
    assert.deepEqual(result, {
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      ANTHROPIC_BASE_URL: 'https://proxy.example.com',
    });
  });

  it('user templates merge with (not replace) built-in mapping', () => {
    const result = resolveEnvMap(
      'anthropic',
      undefined,
      { apiKey: 'my-key' },
      {
        MY_CUSTOM_KEY: '${api_key}',
        MY_ENDPOINT: '${base_url}',
        STATIC_VAR: 'no-template',
      },
    );
    // User templates merge on top of built-in: MY_CUSTOM_KEY added,
    // ANTHROPIC_API_KEY preserved from built-in (P2 fix: merge, not replace)
    assert.deepEqual(result, {
      ANTHROPIC_API_KEY: 'my-key', // from built-in
      MY_CUSTOM_KEY: 'my-key', // from user template
      // MY_ENDPOINT + ANTHROPIC_BASE_URL omitted (baseUrl undefined)
    });
  });

  it('user template overrides built-in key with same name', () => {
    const result = resolveEnvMap(
      'anthropic',
      undefined,
      { apiKey: 'my-key', baseUrl: 'https://proxy.example.com' },
      {
        ANTHROPIC_API_KEY: '${base_url}', // intentionally override built-in mapping
      },
    );
    assert.deepEqual(result, {
      ANTHROPIC_API_KEY: 'https://proxy.example.com', // user override wins
      ANTHROPIC_BASE_URL: 'https://proxy.example.com', // from built-in
    });
  });

  it('omits empty resolved values', () => {
    const result = resolveEnvMap('anthropic', undefined, {
      apiKey: 'sk-xxx',
      // baseUrl is undefined
    });
    assert.deepEqual(result, {
      ANTHROPIC_API_KEY: 'sk-xxx',
      // ANTHROPIC_BASE_URL omitted because baseUrl is empty
    });
  });

  it('returns empty for undefined account', () => {
    const result = resolveEnvMap('anthropic', undefined, undefined);
    assert.deepEqual(result, {});
  });

  it('returns empty for unknown clientId with no provider', () => {
    const result = resolveEnvMap('unknown-client', undefined, { apiKey: 'xxx' });
    assert.deepEqual(result, {});
  });

  it('resolves kimi built-in mapping', () => {
    const result = resolveEnvMap('kimi', undefined, { apiKey: 'moonshot-xxx' });
    assert.deepEqual(result, {
      MOONSHOT_API_KEY: 'moonshot-xxx',
    });
  });

  it('generic acp clientId uses user templates', () => {
    const result = resolveEnvMap(
      'acp',
      undefined,
      { apiKey: 'custom-key' },
      {
        DEEPSEEK_API_KEY: '${api_key}',
      },
    );
    assert.deepEqual(result, {
      DEEPSEEK_API_KEY: 'custom-key',
    });
  });

  it('user templates can pass the configured base model', () => {
    const result = resolveEnvMap(
      'acp',
      undefined,
      { apiKey: 'custom-key', baseModel: 'anthropic/claude-sonnet-4-6' },
      {
        KIMI_API_KEY: '${api_key}',
        KIMI_MODEL_NAME: '${base_model}',
      },
    );
    assert.deepEqual(result, {
      KIMI_API_KEY: 'custom-key',
      KIMI_MODEL_NAME: 'anthropic/claude-sonnet-4-6',
    });
  });

  it('generic acp external clients require explicit user env templates', () => {
    assert.deepEqual(
      resolveEnvMap('acp', undefined, {
        apiKey: 'moonshot-xxx',
        baseUrl: 'https://api.moonshot.cn/v1',
      }),
      {},
    );

    const result = resolveEnvMap(
      'acp',
      undefined,
      {
        apiKey: 'moonshot-xxx',
        baseUrl: 'https://api.moonshot.cn/v1',
      },
      {
        KIMI_API_KEY: '${api_key}',
        KIMI_BASE_URL: '${base_url}',
      },
    );
    assert.deepEqual(result, {
      KIMI_API_KEY: 'moonshot-xxx',
      KIMI_BASE_URL: 'https://api.moonshot.cn/v1',
    });
  });
});

describe('F161: env-map — sanitizer (F171 parity)', () => {
  it('rejects CAT_CAFE_ prefix from user templates', () => {
    const result = resolveEnvMap(
      'acp',
      undefined,
      { apiKey: 'evil-key' },
      {
        CAT_CAFE_API_URL: '${api_key}',
        SAFE_KEY: '${api_key}',
      },
    );
    // CAT_CAFE_API_URL must NOT appear — reserved prefix
    assert.deepEqual(result, {
      SAFE_KEY: 'evil-key',
    });
  });

  it('rejects invalid env key names from user templates', () => {
    const result = resolveEnvMap(
      'acp',
      undefined,
      { apiKey: 'key' },
      {
        'invalid-key': '${api_key}',
        '3INVALID': '${api_key}',
        VALID_KEY: '${api_key}',
      },
    );
    assert.deepEqual(result, {
      VALID_KEY: 'key',
    });
  });
});

describe('F161: env-map — extractUserEnvTemplates', () => {
  it('extracts only template entries', () => {
    const result = extractUserEnvTemplates({
      MY_KEY: '${api_key}',
      MY_URL: '${base_url}',
      STATIC: 'plain-value',
    });
    assert.deepEqual(result, {
      MY_KEY: '${api_key}',
      MY_URL: '${base_url}',
    });
  });

  it('does not classify unsupported placeholders as Clowder AI templates', () => {
    const result = extractUserEnvTemplates({
      HTTPS_PROXY: 'http://${PROXY_HOST}:8080',
      MIXED_TEMPLATE: '${api_key}:${PROXY_HOST}',
      STATIC: 'plain-value',
    });
    assert.deepEqual(result, {
      MIXED_TEMPLATE: '${api_key}:${PROXY_HOST}',
    });
  });

  it('returns undefined for no templates', () => {
    const result = extractUserEnvTemplates({
      STATIC: 'plain-value',
      HTTPS_PROXY: 'http://${PROXY_HOST}:8080',
    });
    assert.equal(result, undefined);
  });

  it('returns undefined for empty input', () => {
    assert.equal(extractUserEnvTemplates(undefined), undefined);
    assert.equal(extractUserEnvTemplates({}), undefined);
  });
});

describe('F161: env-map — BUILTIN_ENV_MAPS coverage', () => {
  it('has mappings for all expected providers', () => {
    const expected = ['anthropic', 'openai', 'google', 'openrouter', 'kimi', 'opencode'];
    for (const provider of expected) {
      assert.ok(BUILTIN_ENV_MAPS[provider], `Missing built-in map for ${provider}`);
      assert.ok(Object.keys(BUILTIN_ENV_MAPS[provider]).length > 0, `Empty built-in map for ${provider}`);
    }
  });

  it('all templates use only known variables', () => {
    const knownVars = new Set(['api_key', 'base_url']);
    for (const [provider, map] of Object.entries(BUILTIN_ENV_MAPS)) {
      for (const [envKey, template] of Object.entries(map)) {
        const matches = [...template.matchAll(/\$\{(\w+)\}/g)];
        for (const match of matches) {
          assert.ok(knownVars.has(match[1]), `Unknown variable \${${match[1]}} in ${provider}.${envKey}`);
        }
      }
    }
  });
});
