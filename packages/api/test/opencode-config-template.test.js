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

describe('parseOpenCodeModel', () => {
  test('parses provider/model format with nested model namespace', () => {
    const parsed = parseOpenCodeModel('maas/google/gemini-3-flash');
    assert.deepStrictEqual(parsed, { providerName: 'maas', modelName: 'google/gemini-3-flash' });
  });

  test('returns null for bare model names', () => {
    assert.equal(parseOpenCodeModel('glm-5'), null);
  });
});

describe('generateOpenCodeRuntimeConfig', () => {
  test('generates custom provider config with env placeholders and stripped model keys', () => {
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'maas',
      models: ['maas/glm-5', 'maas/glm-4-plus'],
      defaultModel: 'maas/glm-5',
      apiType: 'openai',
      hasBaseUrl: true,
    });

    assert.equal(config.model, 'maas/glm-5');
    assert.deepStrictEqual(config.provider.maas.models, {
      'glm-5': { name: 'glm-5' },
      'glm-4-plus': { name: 'glm-4-plus' },
    });
    assert.equal(config.provider.maas.npm, '@ai-sdk/openai-compatible');
    assert.equal(config.provider.maas.options.baseURL, `{env:${OC_BASE_URL_ENV}}`);
    assert.equal(config.provider.maas.options.apiKey, `{env:${OC_API_KEY_ENV}}`);
  });
});

describe('writeOpenCodeRuntimeConfig', () => {
  test('writes invocation-scoped runtime config under .cat-cafe', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'oc-runtime-config-'));
    try {
      const configPath = writeOpenCodeRuntimeConfig(tmpRoot, 'opencode-maas', 'inv-123', {
        providerName: 'maas',
        models: ['maas/glm-5'],
        defaultModel: 'maas/glm-5',
        apiType: 'openai',
        hasBaseUrl: true,
      });

      assert.ok(existsSync(configPath), 'runtime config file must exist');
      assert.match(configPath, /\.cat-cafe\/opencode-runtime-opencode-maas-inv-123\.json$/);
      const content = JSON.parse(readFileSync(configPath, 'utf-8'));
      assert.equal(content.model, 'maas/glm-5');
      assert.deepStrictEqual(content.provider.maas.models, { 'glm-5': { name: 'glm-5' } });
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
