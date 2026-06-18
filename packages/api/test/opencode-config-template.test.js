import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { prepareOpenCodeAcpSpawnConfig } from '../dist/domains/cats/services/agents/providers/opencode-acp-spawn-config.js';
import {
  deriveOpenCodeApiType,
  generateOpenCodeConfig,
  generateOpenCodeRuntimeConfig,
  OC_API_KEY_ENV,
  OC_BASE_URL_ENV,
  parseOpenCodeModel,
  summarizeOpenCodeRuntimeConfigForDebug,
  writeOpenCodeInstructionsOnlyConfig,
  writeOpenCodeRuntimeConfig,
} from '../dist/domains/cats/services/agents/providers/opencode-config-template.js';

describe('opencode config module boundaries', () => {
  test('keeps ACP spawn config in a dedicated module under the line budget', () => {
    const templateSource = readFileSync(
      new URL('../src/domains/cats/services/agents/providers/opencode-config-template.ts', import.meta.url),
      'utf8',
    );
    const spawnSource = readFileSync(
      new URL('../src/domains/cats/services/agents/providers/opencode-acp-spawn-config.ts', import.meta.url),
      'utf8',
    );

    assert.ok(
      templateSource.split('\n').length <= 350,
      'opencode-config-template.ts should stay under the 350-line module budget',
    );
    assert.match(spawnSource, /prepareOpenCodeAcpSpawnConfig/);
  });
});

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

  test('does not include Clowder AI MCP tools in config', () => {
    const config = generateOpenCodeConfig({
      apiKey: 'sk-test',
      baseUrl: 'https://proxy.example/v1',
      model: 'claude-sonnet-4-6',
    });

    // MCP config should not reference any cat_cafe tools
    if (config.mcp) {
      const mcpKeys = Object.keys(config.mcp);
      for (const key of mcpKeys) {
        assert.ok(!key.startsWith('cat_cafe'), `MCP config must not include Clowder AI tools: ${key}`);
        assert.ok(!key.startsWith('cat-cafe'), `MCP config must not include Clowder AI tools: ${key}`);
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

describe('deriveOpenCodeApiType', () => {
  test('derives apiType solely from providerName', () => {
    const scenarios = [
      { ocProviderName: 'anthropic', expected: 'anthropic' },
      { ocProviderName: 'google', expected: 'google' },
      { ocProviderName: 'openai-responses', expected: 'openai-responses' },
      { ocProviderName: 'maas', expected: 'openai' },
      { ocProviderName: 'deepseek', expected: 'openai' },
      { ocProviderName: 'minimax', expected: 'openai' },
      { ocProviderName: 'openrouter', expected: 'openai' },
      { ocProviderName: undefined, expected: 'openai' },
    ];
    for (const { ocProviderName, expected } of scenarios) {
      assert.equal(deriveOpenCodeApiType(ocProviderName), expected, `ocProviderName=${ocProviderName} → ${expected}`);
    }
  });

  test('openai-responses is reachable', () => {
    assert.equal(deriveOpenCodeApiType('openai-responses'), 'openai-responses');
  });

  test('case-insensitive ocProviderName matching', () => {
    assert.equal(deriveOpenCodeApiType('Anthropic'), 'anthropic');
    assert.equal(deriveOpenCodeApiType('OPENAI-RESPONSES'), 'openai-responses');
    assert.equal(deriveOpenCodeApiType('OpenAI-Responses'), 'openai-responses');
    assert.equal(deriveOpenCodeApiType('Google'), 'google');
  });
});

describe('prepareOpenCodeAcpSpawnConfig', () => {
  test('writes OPENCODE_CONFIG and credential env for OpenCode ACP api_key accounts', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-opencode-acp-'));
    try {
      const prepared = prepareOpenCodeAcpSpawnConfig({
        projectRoot,
        profileId: 'opencode-acp',
        clientId: 'opencode',
        command: '/opt/homebrew/bin/opencode',
        providerName: 'anthropic',
        defaultModel: 'anthropic/claude-opus-4-6',
        account: {
          id: 'anthropic-proxy',
          authType: 'api_key',
          apiKey: 'sk-test-secret',
          baseUrl: 'https://proxy.example/v1',
          models: ['claude-opus-4-6'],
        },
      });

      assert.ok(prepared, 'OpenCode ACP should receive a prepared spawn config');
      assert.ok(prepared.env.OPENCODE_CONFIG, 'OPENCODE_CONFIG must be set for OpenCode ACP');
      assert.equal(prepared.env[OC_API_KEY_ENV], 'sk-test-secret');
      assert.equal(prepared.env[OC_BASE_URL_ENV], 'https://proxy.example/v1');

      const config = JSON.parse(readFileSync(prepared.env.OPENCODE_CONFIG, 'utf8'));
      assert.equal(config.model, 'anthropic/claude-opus-4-6');
      assert.equal(config.small_model, 'anthropic/claude-opus-4-6');
      assert.equal(config.provider.anthropic.options.apiKey, `{env:${OC_API_KEY_ENV}}`);
      assert.equal(config.provider.anthropic.options.baseURL, `{env:${OC_BASE_URL_ENV}}`);
      assert.ok(!JSON.stringify(config).includes('sk-test-secret'), 'runtime config must not write secrets');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('does NOT manage generic ACP by command basename (clientId=acp + command=opencode → null)', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-opencode-acp-generic-'));
    try {
      // F161 cleanup: generic ACP (clientId='acp') must NOT be auto-upgraded to
      // OpenCode managed config by sniffing the command basename. OpenCode managed
      // config is opt-in via clientId='opencode' only. A generic carrier that happens
      // to point at the opencode binary stays on the pure generic env path.
      const prepared = prepareOpenCodeAcpSpawnConfig({
        projectRoot,
        profileId: 'generic-acp-opencode',
        clientId: 'acp',
        command: 'opencode',
        providerName: undefined,
        defaultModel: 'anthropic/claude-opus-4-6',
        account: {
          id: 'anthropic-proxy',
          authType: 'api_key',
          apiKey: 'sk-test-secret',
          baseUrl: 'https://proxy.example/v1',
          models: ['claude-opus-4-6'],
        },
      });

      assert.equal(prepared, null, 'generic ACP must not get OpenCode managed config via command sniffing');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('skips non-OpenCode ACP clients', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-opencode-acp-skip-'));
    try {
      const prepared = prepareOpenCodeAcpSpawnConfig({
        projectRoot,
        profileId: 'gemini-acp',
        clientId: 'google',
        command: 'gemini',
        providerName: 'google',
        defaultModel: 'gemini-3-flash',
        account: {
          id: 'gemini',
          authType: 'oauth',
          models: ['gemini-3-flash'],
        },
      });

      assert.equal(prepared, null);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
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
    assert.equal(config.small_model, 'maas/glm-5');
    assert.deepStrictEqual(config.provider.maas.models, {
      'glm-5': { name: 'glm-5' },
      'glm-4-plus': { name: 'glm-4-plus' },
    });
    assert.equal(config.provider.maas.npm, '@ai-sdk/openai-compatible');
    assert.equal(config.provider.maas.options.baseURL, `{env:${OC_BASE_URL_ENV}}`);
    assert.equal(config.provider.maas.options.apiKey, `{env:${OC_API_KEY_ENV}}`);
  });

  test('apiType maps to correct npm adapters', () => {
    const cases = [
      { apiType: 'openai', expectedNpm: '@ai-sdk/openai-compatible' },
      { apiType: 'openai-responses', expectedNpm: '@ai-sdk/openai' },
      { apiType: 'anthropic', expectedNpm: '@ai-sdk/anthropic' },
      { apiType: 'google', expectedNpm: '@ai-sdk/google' },
    ];
    for (const { apiType, expectedNpm } of cases) {
      const config = generateOpenCodeRuntimeConfig({
        providerName: 'test-provider',
        models: ['test-model'],
        apiType,
      });
      assert.equal(config.provider['test-provider'].npm, expectedNpm, `apiType=${apiType} → npm=${expectedNpm}`);
    }
  });

  test('providerName "openai" is remapped to avoid OpenCode builtin collision', () => {
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'openai',
      models: ['openai/gpt-4o'],
      defaultModel: 'openai/gpt-4o',
      apiType: 'openai',
      hasBaseUrl: true,
    });
    // Provider key must NOT be 'openai' — OpenCode treats it as built-in and
    // forces Responses API, ignoring the npm adapter field.
    assert.equal(config.provider['openai'], undefined, 'must not use reserved "openai" key');
    assert.ok(config.provider['openai-compat'], 'must use remapped "openai-compat" key');
    assert.equal(config.provider['openai-compat'].npm, '@ai-sdk/openai-compatible');
    assert.equal(config.model, 'openai-compat/gpt-4o', 'model prefix must match remapped provider key');
  });

  test('registers defaultModel even when the account model list is stale', () => {
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'openai',
      models: ['qwen3.6-plus', 'Qwen3.6-Max', 'kimi-2.6'],
      defaultModel: 'openai/qwen3.6-max-preview',
      apiType: 'openai',
      hasBaseUrl: true,
    });

    assert.equal(config.model, 'openai-compat/qwen3.6-max-preview');
    assert.ok(config.provider['openai-compat'].models?.['qwen3.6-max-preview']);
  });

  test('pins small_model to the remapped default model for OpenCode title generation', () => {
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'openai',
      models: ['gpt-4o'],
      defaultModel: 'openai/gpt-4o',
      apiType: 'openai',
      hasBaseUrl: true,
    });

    assert.equal(config.model, 'openai-compat/gpt-4o');
    assert.equal(config.small_model, 'openai-compat/gpt-4o');
  });

  test('non-reserved providerName is kept as-is', () => {
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'kimi',
      models: ['kimi/moonshot-v2'],
      defaultModel: 'kimi/moonshot-v2',
      apiType: 'openai',
    });
    assert.ok(config.provider['kimi'], 'custom name must be preserved');
    assert.equal(config.model, 'kimi/moonshot-v2');
  });

  test('unknown apiType falls back to openai-compatible adapter', () => {
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'test',
      models: ['m1'],
      apiType: 'bogus',
    });
    assert.equal(config.provider.test.npm, '@ai-sdk/openai-compatible');
  });

  test('mcpServerPath injects mcp.cat-cafe section into config', () => {
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'anthropic',
      models: ['anthropic/claude-opus-4-6'],
      defaultModel: 'anthropic/claude-opus-4-6',
      apiType: 'anthropic',
      mcpServerPath: '/absolute/path/to/packages/mcp-server/dist/index.js',
    });

    assert.ok(config.mcp, 'config must have mcp section when mcpServerPath is provided');
    assert.deepStrictEqual(config.mcp['cat-cafe'], {
      type: 'local',
      command: ['node', '/absolute/path/to/packages/mcp-server/dist/index.js'],
    });
  });

  test('#871: non-api_key runtime config can omit provider auth placeholders', () => {
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'anthropic',
      models: ['anthropic/claude-opus-4-6'],
      defaultModel: 'anthropic/claude-opus-4-6',
      apiType: 'anthropic',
      hasBaseUrl: true,
      mcpServerPath: '/absolute/path/to/packages/mcp-server/dist/index.js',
      omitProviderAuth: true,
    });

    assert.equal(config.model, 'anthropic/claude-opus-4-6');
    assert.ok(config.provider.anthropic, 'model/provider routing must still be present');
    assert.equal(
      config.provider.anthropic.options.apiKey,
      undefined,
      'OAuth/native-auth runtime config must not reference missing CAT_CAFE_OC_API_KEY',
    );
    assert.equal(
      config.provider.anthropic.options.baseURL,
      undefined,
      'OAuth/native-auth runtime config must not reference missing CAT_CAFE_OC_BASE_URL',
    );
    assert.ok(config.mcp?.['cat-cafe'], 'MCP injection must still be present');
  });

  test('mcp section is absent when mcpServerPath is not provided', () => {
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'maas',
      models: ['maas/glm-5'],
      defaultModel: 'maas/glm-5',
      apiType: 'openai',
    });

    assert.strictEqual(config.mcp, undefined, 'config must not have mcp section without mcpServerPath');
  });

  test('#935: externalDirectories emits OpenCode external_directory permission globs', () => {
    const config = generateOpenCodeRuntimeConfig({
      providerName: 'anthropic',
      models: ['anthropic/claude-opus-4-6'],
      defaultModel: 'anthropic/claude-opus-4-6',
      apiType: 'anthropic',
      externalDirectories: ['/Users/lysander/projects/cat-cafe/', 'C:\\Users\\lysander\\monorepo'],
    });

    assert.deepStrictEqual(config.permission, {
      external_directory: {
        '/Users/lysander/projects/cat-cafe/**': 'allow',
        'C:/Users/lysander/monorepo/**': 'allow',
      },
    });
  });

  test('summarizeOpenCodeRuntimeConfigForDebug reports provider adapter and model keys', () => {
    const summary = summarizeOpenCodeRuntimeConfigForDebug({
      providerName: 'anthropic',
      models: ['anthropic/minimax-m2.7', 'anthropic/minimax-text-01'],
      defaultModel: 'anthropic/minimax-m2.7',
      apiType: 'anthropic',
      hasBaseUrl: true,
    });

    assert.equal(summary.model, 'anthropic/minimax-m2.7');
    assert.equal(summary.smallModel, 'anthropic/minimax-m2.7');
    assert.deepStrictEqual(summary.providerKeys, ['anthropic']);
    assert.deepStrictEqual(summary.providerSummary, {
      anthropic: {
        npm: '@ai-sdk/anthropic',
        modelKeys: ['minimax-m2.7', 'minimax-text-01'],
        hasBaseUrl: true,
        apiKeySource: `env:${OC_API_KEY_ENV}`,
        baseUrlSource: `env:${OC_BASE_URL_ENV}`,
      },
    });
  });
});

describe('writeOpenCodeInstructionsOnlyConfig', () => {
  test('#935: writes external_directory permission rules without provider config', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'oc-instructions-only-external-'));
    try {
      const configPath = writeOpenCodeInstructionsOnlyConfig(
        tmpRoot,
        'opencode',
        'inv-external',
        ['/tmp/l0.md', '/project/OPENCODE.md'],
        ['/opt/cat-cafe'],
      );

      const content = JSON.parse(readFileSync(configPath, 'utf-8'));
      assert.deepStrictEqual(content.instructions, ['/tmp/l0.md', '/project/OPENCODE.md']);
      assert.deepStrictEqual(content.permission, {
        external_directory: {
          '/opt/cat-cafe/**': 'allow',
        },
      });
      assert.strictEqual(content.provider, undefined, 'instructions-only config must not add provider');
      assert.strictEqual(content.model, undefined, 'instructions-only config must not add model');
      assert.strictEqual(content.mcp, undefined, 'instructions-only config must not add mcp');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('writeOpenCodeRuntimeConfig', () => {
  test('writes invocation-scoped runtime config file under .cat-cafe (OPENCODE_CONFIG)', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'oc-runtime-config-'));
    try {
      const configPath = writeOpenCodeRuntimeConfig(tmpRoot, 'opencode-maas', 'inv-123', {
        providerName: 'maas',
        models: ['maas/glm-5'],
        defaultModel: 'maas/glm-5',
        apiType: 'openai',
        hasBaseUrl: true,
      });

      assert.match(configPath, /\.cat-cafe\/oc-config-opencode-maas-inv-123\/opencode\.json$/);
      assert.ok(existsSync(configPath), 'opencode.json must exist at returned config path');
      const content = JSON.parse(readFileSync(configPath, 'utf-8'));
      assert.equal(content.model, 'maas/glm-5');
      assert.deepStrictEqual(content.provider.maas.models, { 'glm-5': { name: 'glm-5' } });
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('persists mcp.cat-cafe section to disk when mcpServerPath is provided', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'oc-runtime-mcp-'));
    try {
      const mcpPath = '/opt/cat-cafe/packages/mcp-server/dist/index.js';
      const configPath = writeOpenCodeRuntimeConfig(tmpRoot, 'opencode', 'inv-game-001', {
        providerName: 'anthropic',
        models: ['anthropic/claude-opus-4-6'],
        defaultModel: 'anthropic/claude-opus-4-6',
        apiType: 'anthropic',
        mcpServerPath: mcpPath,
      });

      const content = JSON.parse(readFileSync(configPath, 'utf-8'));
      assert.deepStrictEqual(content.mcp, {
        'cat-cafe': { type: 'local', command: ['node', mcpPath] },
      });
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
