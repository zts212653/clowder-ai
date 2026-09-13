// @ts-check

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  MissingMcpEnvironmentVariableError,
  readExactMcpEnvironmentReference,
  renderMcpServerEnvReferences,
  resolveMcpServerEnvReferences,
} = await import('../dist/config/capabilities/mcp-env-reference.js');

describe('resolveMcpServerEnvReferences', () => {
  it('resolves full and embedded environment references without mutating the descriptor', () => {
    const descriptor = {
      name: 'zai',
      transport: 'streamableHttp',
      command: '',
      args: [],
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer ${Z_AI_API_KEY}', 'X-Literal': 'safe' },
      env: { Z_AI_API_KEY: '${Z_AI_API_KEY}', MODE: 'ZHIPU' },
      enabled: true,
      source: 'external',
    };

    const resolved = resolveMcpServerEnvReferences(descriptor, { Z_AI_API_KEY: 'test-secret' });

    assert.notStrictEqual(resolved, descriptor);
    assert.deepEqual(resolved.headers, { Authorization: 'Bearer test-secret', 'X-Literal': 'safe' });
    assert.deepEqual(resolved.env, { Z_AI_API_KEY: 'test-secret', MODE: 'ZHIPU' });
    assert.equal(descriptor.headers.Authorization, 'Bearer ${Z_AI_API_KEY}');
    assert.equal(descriptor.env.Z_AI_API_KEY, '${Z_AI_API_KEY}');
  });

  it('fails closed when a referenced environment variable is absent', () => {
    const descriptor = {
      name: 'zai',
      command: 'npx',
      args: ['-y', '@z_ai/mcp-server'],
      env: { Z_AI_API_KEY: '${Z_AI_API_KEY}' },
      enabled: true,
      source: 'external',
    };

    assert.throws(
      () => resolveMcpServerEnvReferences(descriptor, {}),
      (error) => {
        assert.ok(error instanceof MissingMcpEnvironmentVariableError);
        assert.match(error.message, /zai/);
        assert.match(error.message, /Z_AI_API_KEY/);
        return true;
      },
    );
  });

  it('treats an empty referenced value as missing', () => {
    const descriptor = {
      name: 'remote',
      transport: 'streamableHttp',
      command: '',
      args: [],
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer ${TOKEN}' },
      enabled: true,
      source: 'external',
    };

    assert.throws(() => resolveMcpServerEnvReferences(descriptor, { TOKEN: '' }), MissingMcpEnvironmentVariableError);
  });

  it('validates then renders provider-native placeholders without materializing secrets', () => {
    const descriptor = {
      name: 'remote',
      headers: { Authorization: 'Bearer ${TOKEN}' },
      env: { TOKEN: '${TOKEN}' },
    };

    const rendered = renderMcpServerEnvReferences(descriptor, (name) => `{env:${name}}`, {
      TOKEN: 'must-not-be-persisted',
    });

    assert.deepEqual(rendered.headers, { Authorization: 'Bearer {env:TOKEN}' });
    assert.deepEqual(rendered.env, { TOKEN: '{env:TOKEN}' });
    assert.doesNotMatch(JSON.stringify(rendered), /must-not-be-persisted/);
  });

  it('recognizes only whole-value references for provider-native forwarding', () => {
    assert.equal(readExactMcpEnvironmentReference('${TOKEN}'), 'TOKEN');
    assert.equal(readExactMcpEnvironmentReference('Bearer ${TOKEN}'), undefined);
    assert.equal(readExactMcpEnvironmentReference('${TOKEN:-fallback}'), undefined);
  });
});
