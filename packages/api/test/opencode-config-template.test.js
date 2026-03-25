import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  generateOpenCodeConfig,
  generateOpenCodeRuntimeConfig,
  OC_API_KEY_ENV,
  OC_BASE_URL_ENV,
  parseOpenCodeModel,
  writeOpenCodeRuntimeConfig,
} from '../dist/domains/cats/services/agents/providers/opencode-config-template.js';

describe('opencode Config Template (AC-9 + AC-10)', () => {
  test('generates valid opencode config with required fields', () => {
    const config = generateOpenCodeConfig({
      apiKey: 'sk-test-key',
      baseUrl: 'https://chat.nuoda.vip/claudecode/v1',
      model: 'claude-sonnet-4-6',
    });

    assert.ok(config.$schema, 'must have $schema');
    assert.ok(config.provider?.anthropic, 'must have anthropic provider');
    assert.strictEqual(config.provider.anthropic.options.apiKey, undefined, 'apiKey must not be in config');
    assert.strictEqual(config.provider.anthropic.options.baseURL, 'https://chat.nuoda.vip/claudecode/v1');
  });

  test('model is set at top level', () => {
    const config = generateOpenCodeConfig({
      apiKey: 'sk-test',
      baseUrl: 'https://proxy.example/v1',
      model: 'claude-sonnet-4-6',
    });

    assert.strictEqual(config.model, 'claude-sonnet-4-6');
  });

  test('model without provider prefix is preserved as-is', () => {
    const config = generateOpenCodeConfig({
      apiKey: 'sk-test',
      baseUrl: 'https://proxy.example/v1',
      model: 'claude-haiku-4-5',
    });

    assert.strictEqual(config.model, 'claude-haiku-4-5');
  });

  test('model with existing provider prefix is preserved', () => {
    const config = generateOpenCodeConfig({
      apiKey: 'sk-test',
      baseUrl: 'https://proxy.example/v1',
      model: 'anthropic/claude-sonnet-4-6',
    });

    assert.strictEqual(config.model, 'anthropic/claude-sonnet-4-6');
  });

  test('OMOC plugin is enabled by default', () => {
    const config = generateOpenCodeConfig({
      apiKey: 'sk-test',
      baseUrl: 'https://proxy.example/v1',
      model: 'claude-sonnet-4-6',
    });

    assert.ok(Array.isArray(config.plugin), 'plugin must be an array');
    assert.ok(config.plugin.includes('oh-my-opencode'), 'must include oh-my-opencode plugin');
  });

  test('OMOC can be disabled', () => {
    const config = generateOpenCodeConfig({
      apiKey: 'sk-test',
      baseUrl: 'https://proxy.example/v1',
      model: 'claude-sonnet-4-6',
      enableOmoc: false,
    });

    assert.ok(
      !config.plugin || !config.plugin.includes('oh-my-opencode'),
      'oh-my-opencode should not be in plugin list when disabled',
    );
  });

  test('does not include Cat Cafe MCP tools in config', () => {
    const config = generateOpenCodeConfig({
      apiKey: 'sk-test',
      baseUrl: 'https://proxy.example/v1',
      model: 'claude-sonnet-4-6',
    });

    // MCP config should not reference any cat_cafe tools
    if (config.mcp) {
      const mcpKeys = Object.keys(config.mcp);
      for (const key of mcpKeys) {
        assert.ok(!key.startsWith('cat_cafe'), `MCP config must not include Cat Cafe tools: ${key}`);
        assert.ok(!key.startsWith('cat-cafe'), `MCP config must not include Cat Cafe tools: ${key}`);
      }
    }
  });

  test('apiKey is NOT written into generated config (env-only)', () => {
    const config = generateOpenCodeConfig({
      apiKey: 'sk-secret-key',
      baseUrl: 'https://proxy.example/v1',
      model: 'claude-sonnet-4-6',
    });

    // Secret must stay in ANTHROPIC_API_KEY env var, not in opencode.json on disk
    assert.strictEqual(config.provider.anthropic.options.apiKey, undefined, 'apiKey must not appear in config');
    const json = JSON.stringify(config);
    assert.ok(!json.includes('sk-secret-key'), 'secret must not appear anywhere in serialized config');
  });

  test('baseUrl without /v1 is preserved as-is', () => {
    const config = generateOpenCodeConfig({
      apiKey: 'sk-test',
      baseUrl: 'https://chat.nuoda.vip/claudecode',
      model: 'claude-sonnet-4-6',
    });

    assert.strictEqual(config.provider.anthropic.options.baseURL, 'https://chat.nuoda.vip/claudecode');
  });

  test('baseUrl already ending in /v1 is preserved', () => {
    const config = generateOpenCodeConfig({
      apiKey: 'sk-test',
      baseUrl: 'https://chat.nuoda.vip/claudecode/v1',
      model: 'claude-sonnet-4-6',
    });

    assert.strictEqual(config.provider.anthropic.options.baseURL, 'https://chat.nuoda.vip/claudecode/v1');
  });

  test('baseUrl ending in /v1/ (trailing slash) is preserved', () => {
    const config = generateOpenCodeConfig({
      apiKey: 'sk-test',
      baseUrl: 'https://proxy.example/v1/',
      model: 'claude-sonnet-4-6',
    });

    assert.strictEqual(config.provider.anthropic.options.baseURL, 'https://proxy.example/v1/');
  });

  test('baseUrl with trailing slash (non-v1) is preserved as-is', () => {
    const config = generateOpenCodeConfig({
      apiKey: 'sk-test',
      baseUrl: 'https://proxy.example/',
      model: 'claude-sonnet-4-6',
    });

    assert.strictEqual(config.provider.anthropic.options.baseURL, 'https://proxy.example/');
  });

  test('output is valid JSON (serializable)', () => {
    const config = generateOpenCodeConfig({
      apiKey: 'sk-test',
      baseUrl: 'https://proxy.example/v1',
      model: 'claude-sonnet-4-6',
    });

    const json = JSON.stringify(config);
    const parsed = JSON.parse(json);
    assert.deepStrictEqual(parsed, config, 'config must be JSON-serializable');
  });
});

// ── F189: Custom provider runtime config ──────────────────────────────────

describe('parseOpenCodeModel', () => {
  test('parses provider/model format', () => {
    const result = parseOpenCodeModel('maas/glm-5');
    assert.deepStrictEqual(result, { providerName: 'maas', modelName: 'glm-5' });
  });

  test('parses multi-segment model name', () => {
    const result = parseOpenCodeModel('openrouter/google/gemini-3-flash');
    assert.deepStrictEqual(result, { providerName: 'openrouter', modelName: 'google/gemini-3-flash' });
  });

  test('returns null for bare model name', () => {
    assert.strictEqual(parseOpenCodeModel('claude-sonnet-4-6'), null);
  });

  test('returns null for empty string', () => {
    assert.strictEqual(parseOpenCodeModel(''), null);
  });

  test('returns null for leading slash', () => {
    assert.strictEqual(parseOpenCodeModel('/model'), null);
  });

  test('returns null for trailing slash', () => {
    assert.strictEqual(parseOpenCodeModel('provider/'), null);
  });

  test('trims whitespace', () => {
    const result = parseOpenCodeModel('  maas/glm-5  ');
    assert.deepStrictEqual(result, { providerName: 'maas', modelName: 'glm-5' });
  });
});

describe('generateOpenCodeRuntimeConfig', () => {
  test('generates config with custom provider and {env:VAR} credentials (official format)', () => {
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'maas',
      models: ['glm-5', 'glm-4-plus'],
      defaultModel: 'maas/glm-5',
      hasBaseUrl: true,
    });

    assert.ok(config.$schema, 'must have $schema');
    assert.strictEqual(config.model, 'maas/glm-5');
    assert.ok(config.provider.maas, 'must have custom provider block');

    const provider = config.provider.maas;
    // Official format: npm adapter, not "api" shorthand
    assert.strictEqual(provider.npm, '@ai-sdk/openai-compatible', 'default npm adapter is openai-compatible');
    assert.strictEqual(provider.api, undefined, 'must not use legacy "api" field');
    // Official format: keyed object { modelId: { name } }, not array
    assert.deepStrictEqual(provider.models, { 'glm-5': { name: 'glm-5' }, 'glm-4-plus': { name: 'glm-4-plus' } });
    assert.strictEqual(provider.options.baseURL, `{env:${OC_BASE_URL_ENV}}`);
    assert.strictEqual(provider.options.apiKey, `{env:${OC_API_KEY_ENV}}`);
  });

  test('credentials use env substitution, no hardcoded secrets', () => {
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'deepseek',
      models: ['deepseek-r2'],
    });

    const json = JSON.stringify(config);
    assert.ok(json.includes('{env:'), 'config must use {env:VAR} substitution');
    assert.ok(!json.includes('sk-'), 'no hardcoded secrets allowed');
  });

  test('respects explicit apiType override → correct npm adapter', () => {
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'my-anthropic-proxy',
      models: ['claude-sonnet-4-6'],
      apiType: 'anthropic',
    });

    assert.strictEqual(config.provider['my-anthropic-proxy'].npm, '@ai-sdk/anthropic');
  });

  test('google apiType maps to @ai-sdk/google', () => {
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'my-google-proxy',
      models: ['gemini-3-flash'],
      apiType: 'google',
    });

    assert.strictEqual(config.provider['my-google-proxy'].npm, '@ai-sdk/google');
  });

  test('models keyed object keys match -m routing (modelId is the key)', () => {
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'maas',
      models: ['glm-5'],
      defaultModel: 'maas/glm-5',
    });

    // When opencode CLI receives `-m maas/glm-5`, it looks up provider.maas.models["glm-5"]
    const modelKeys = Object.keys(config.provider.maas.models);
    assert.deepStrictEqual(modelKeys, ['glm-5'], 'model key must match what -m routes to');
  });

  test('default apiType is openai (openai-compatible) when omitted', () => {
    // Covers the "no protocol on profile" scenario (protocol UI removed).
    // Most third-party APIs (maas, deepseek, etc.) are OpenAI-compatible.
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'maas',
      models: ['glm-5'],
      defaultModel: 'maas/glm-5',
      // apiType intentionally omitted — should default to 'openai'
    });

    assert.strictEqual(
      config.provider.maas.npm,
      '@ai-sdk/openai-compatible',
      'omitted apiType must default to @ai-sdk/openai-compatible (not @ai-sdk/anthropic)',
    );
  });

  test('omits model field when defaultModel is not provided', () => {
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'maas',
      models: ['glm-5'],
    });

    assert.strictEqual(config.model, undefined);
  });

  test('output is valid JSON', () => {
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'maas',
      models: ['glm-5'],
      defaultModel: 'maas/glm-5',
    });

    const json = JSON.stringify(config);
    const parsed = JSON.parse(json);
    assert.deepStrictEqual(parsed, config);
  });
});

describe('writeOpenCodeRuntimeConfig', () => {
  test('writes per-catId config file to .cat-cafe directory', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'oc-config-test-'));
    try {
      const configPath = writeOpenCodeRuntimeConfig(tmpRoot, 'test-cat', {
        providerName: 'maas',
        models: ['glm-5'],
        defaultModel: 'maas/glm-5',
      });

      assert.ok(existsSync(configPath), 'config file must exist');
      assert.ok(configPath.includes('.cat-cafe'), 'must be in .cat-cafe dir');
      assert.ok(configPath.includes('opencode-runtime-test-cat'), 'must include catId');

      const content = JSON.parse(readFileSync(configPath, 'utf-8'));
      assert.ok(content.provider.maas, 'file must contain custom provider');
      assert.strictEqual(content.model, 'maas/glm-5');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('overwrites existing config on re-invoke', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'oc-config-test-'));
    try {
      writeOpenCodeRuntimeConfig(tmpRoot, 'cat-a', {
        providerName: 'maas',
        models: ['glm-5'],
        defaultModel: 'maas/glm-5',
      });

      const path2 = writeOpenCodeRuntimeConfig(tmpRoot, 'cat-a', {
        providerName: 'deepseek',
        models: ['deepseek-r2'],
        defaultModel: 'deepseek/deepseek-r2',
      });

      const content = JSON.parse(readFileSync(path2, 'utf-8'));
      assert.ok(content.provider.deepseek, 'must have updated provider');
      assert.strictEqual(content.provider.maas, undefined, 'old provider must be gone');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('different catIds produce different files', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'oc-config-test-'));
    try {
      const pathA = writeOpenCodeRuntimeConfig(tmpRoot, 'cat-a', {
        providerName: 'maas',
        models: ['glm-5'],
      });
      const pathB = writeOpenCodeRuntimeConfig(tmpRoot, 'cat-b', {
        providerName: 'deepseek',
        models: ['deepseek-r2'],
      });

      assert.notStrictEqual(pathA, pathB, 'paths must differ');
      assert.ok(existsSync(pathA), 'cat-a config must exist');
      assert.ok(existsSync(pathB), 'cat-b config must exist');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
