/**
 * Unit tests for acp-session-env: per-invocation callback env materialization.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { secretMcpContract } from '../helpers/secret-mcp-contract.js';

const { materializeSessionMcpServers, callbackEnvDiagnostic } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/acp-session-env.js'
);

const CALLBACK_ENV = {
  CAT_CAFE_API_URL: 'http://localhost:3004',
  CAT_CAFE_INVOCATION_ID: 'inv-abc',
  CAT_CAFE_CALLBACK_TOKEN: 'tok-xyz',
  CAT_CAFE_THREAD_ID: 'thread-abc',
  CAT_CAFE_USER_ID: 'user-1',
  CAT_CAFE_CAT_ID: 'gemini',
  CAT_CAFE_SIGNAL_USER: 'gemini',
};

describe('materializeSessionMcpServers', () => {
  it('accepts existing stdio registrations without an env field', () => {
    const base = [{ name: 'cat-cafe-collab', command: 'node', args: ['collab.js'] }];
    assert.match(materializeSessionMcpServers(base)[0].args[0], /secret-mcp-proxy\.js$/);
    const withCallbacks = materializeSessionMcpServers(base, CALLBACK_ENV);
    assert.equal(
      withCallbacks[0].env.find((entry) => entry.name === 'CAT_CAFE_INVOCATION_ID').value,
      CALLBACK_ENV.CAT_CAFE_INVOCATION_ID,
    );
    assert.equal(Object.hasOwn(base[0], 'env'), false);
  });

  it('injects callback env into cat-cafe-* stdio servers', () => {
    const base = [
      { name: 'cat-cafe-collab', command: 'node', args: ['collab.js'], env: [] },
      { name: 'cat-cafe-memory', command: 'node', args: ['memory.js'], env: [{ name: 'KEEP', value: 'yes' }] },
    ];

    const result = materializeSessionMcpServers(base, CALLBACK_ENV);

    assert.equal(result.length, 2);
    const collabEnv = Object.fromEntries(result[0].env.map((e) => [e.name, e.value]));
    assert.equal(collabEnv.CAT_CAFE_API_URL, 'http://localhost:3004');
    assert.equal(collabEnv.CAT_CAFE_CALLBACK_TOKEN, 'tok-xyz');
    assert.equal(collabEnv.CAT_CAFE_THREAD_ID, 'thread-abc');

    const { proxyEnv: memoryEnv, upstream } = secretMcpContract(result[1]);
    assert.equal(upstream.command, base[1].command);
    assert.deepEqual(upstream.args, base[1].args);
    assert.equal(upstream.source, base[1].name);
    assert.equal(upstream.env.KEEP, 'yes', 'Existing env reaches the original child');
    assert.equal(memoryEnv.KEEP, undefined, 'Child settings must not enter the privileged relay');
    assert.equal(memoryEnv.CAT_CAFE_INVOCATION_ID, 'inv-abc');
    assert.equal(memoryEnv.CAT_CAFE_THREAD_ID, 'thread-abc');
  });

  it('injects into exact "cat-cafe" name (not just cat-cafe-* prefixed)', () => {
    const base = [
      { name: 'cat-cafe', command: 'node', args: ['cat-cafe.js'], env: [{ name: 'EXISTING', value: 'keep' }] },
    ];

    const result = materializeSessionMcpServers(base, CALLBACK_ENV);
    const { proxyEnv: envMap, upstream } = secretMcpContract(result[0]);
    assert.equal(envMap.CAT_CAFE_API_URL, 'http://localhost:3004');
    assert.equal(envMap.CAT_CAFE_INVOCATION_ID, 'inv-abc');
    assert.equal(envMap.CAT_CAFE_THREAD_ID, 'thread-abc');
    assert.equal(upstream.command, base[0].command);
    assert.deepEqual(upstream.args, base[0].args);
    assert.equal(upstream.source, base[0].name);
    assert.equal(upstream.env.EXISTING, 'keep', 'Existing env preserved for its consumer');
    assert.equal(envMap.EXISTING, undefined);
  });

  it('protects non-cat-cafe servers without giving their child callback credentials', () => {
    const base = [
      { name: 'playwright', command: 'npx', args: ['@playwright/mcp'], env: [] },
      { name: 'cat-cafe-signals', command: 'node', args: ['signals.js'], env: [] },
    ];

    const result = materializeSessionMcpServers(base, CALLBACK_ENV);
    const outer = Object.fromEntries(result[0].env.map((entry) => [entry.name, entry.value]));
    assert.match(result[0].args[0], /secret-mcp-proxy\.js$/);
    assert.deepEqual(JSON.parse(outer.CAT_CAFE_SECRET_MCP_PROXY_SPEC).env, {});
    assert.ok(result[1].env.length > 0, 'cat-cafe-signals should get env');
  });

  it('does not inject into servers with coincidental cat-cafe prefix (e.g. cat-cafeteria)', () => {
    const base = [
      { name: 'cat-cafeteria', command: 'node', args: ['cafeteria.js'], env: [] },
      { name: 'cat-cafe-collab', command: 'node', args: ['collab.js'], env: [] },
    ];

    const result = materializeSessionMcpServers(base, CALLBACK_ENV);
    const outer = Object.fromEntries(result[0].env.map((entry) => [entry.name, entry.value]));
    assert.deepEqual(
      JSON.parse(outer.CAT_CAFE_SECRET_MCP_PROXY_SPEC).env,
      {},
      'unrelated child does NOT get callback auth',
    );
    assert.ok(result[1].env.length > 0, 'cat-cafe-collab should get callback env');
  });

  it('protects HTTP/SSE servers while preserving their upstream URL and protocol', () => {
    const base = [{ type: 'http', name: 'cat-cafe-http', url: 'http://localhost', headers: [] }];

    const result = materializeSessionMcpServers(base, CALLBACK_ENV);
    const env = Object.fromEntries(result[0].env.map((entry) => [entry.name, entry.value]));
    const spec = JSON.parse(env.CAT_CAFE_SECRET_MCP_PROXY_SPEC);
    assert.equal(spec.url, base[0].url);
    assert.equal(spec.transport, 'http');
  });

  it('still protects MCP without callbackEnv', () => {
    const base = [{ name: 'cat-cafe-collab', command: 'node', args: [], env: [] }];
    const result = materializeSessionMcpServers(base, undefined);
    assert.match(result[0].args[0], /secret-mcp-proxy\.js$/);
    assert.deepEqual(base[0].args, [], 'registration stays unchanged');
  });

  it('still protects MCP when callbackEnv is empty', () => {
    const base = [{ name: 'cat-cafe-collab', command: 'node', args: [], env: [] }];
    const result = materializeSessionMcpServers(base, {});
    assert.match(result[0].args[0], /secret-mcp-proxy\.js$/);
  });

  it('overwrites existing placeholder values', () => {
    const base = [
      {
        name: 'cat-cafe-collab',
        command: 'node',
        args: [],
        env: [
          { name: 'CAT_CAFE_API_URL', value: '${CAT_CAFE_API_URL}' },
          { name: 'OTHER', value: 'keep' },
        ],
      },
    ];

    const result = materializeSessionMcpServers(base, CALLBACK_ENV);
    const { proxyEnv: envMap, upstream } = secretMcpContract(result[0]);
    assert.equal(envMap.CAT_CAFE_API_URL, 'http://localhost:3004', 'Should overwrite placeholder');
    assert.equal(upstream.env.CAT_CAFE_API_URL, 'http://localhost:3004');
    assert.equal(upstream.env.OTHER, 'keep', 'Non-callback env preserved for its consumer');
    assert.equal(envMap.OTHER, undefined);
  });

  it('does not mutate original servers', () => {
    const base = [{ name: 'cat-cafe-collab', command: 'node', args: [], env: [{ name: 'A', value: 'B' }] }];
    const original = JSON.parse(JSON.stringify(base));

    materializeSessionMcpServers(base, CALLBACK_ENV);
    assert.deepStrictEqual(base, original, 'Input should not be mutated');
  });

  for (const credentialFileOnly of [false, true]) {
    it(`preserves native-action transport credentials with file-only=${credentialFileOnly}`, () => {
      const base = [
        {
          name: 'plugin-fixture',
          command: 'node',
          args: [],
          env: [
            { name: 'CLOWDER_PLUGIN_ACTION_TOKEN', value: 'synthetic-action' },
            { name: 'CLOWDER_PLUGIN_ACTION_PATH', value: '/api/plugin-runtime/action' },
            { name: 'CAT_CAFE_INVOCATION_ID', value: 'stale-invocation' },
            { name: 'CAT_CAFE_CALLBACK_TOKEN', value: 'stale-callback' },
          ],
        },
      ];
      const before = structuredClone(base);
      const callbackEnv = { ...CALLBACK_ENV, CAT_CAFE_CREDENTIAL_FILE: '/synthetic/session.json' };
      const result = materializeSessionMcpServers(base, callbackEnv, credentialFileOnly);
      const { proxyEnv, upstream } = secretMcpContract(result[0]);
      assert.equal(upstream.command, base[0].command);
      assert.deepEqual(upstream.args, base[0].args);
      assert.equal(upstream.source, base[0].name);
      assert.equal(upstream.env.CLOWDER_PLUGIN_ACTION_TOKEN, 'synthetic-action');
      assert.equal(upstream.env.CLOWDER_PLUGIN_ACTION_PATH, '/api/plugin-runtime/action');
      assert.equal(proxyEnv.CLOWDER_PLUGIN_ACTION_TOKEN, undefined);
      assert.equal(proxyEnv.CLOWDER_PLUGIN_ACTION_PATH, undefined);
      for (const env of [proxyEnv, upstream.env]) {
        assert.equal(env.CAT_CAFE_CREDENTIAL_FILE, callbackEnv.CAT_CAFE_CREDENTIAL_FILE);
        assert.equal(env.CAT_CAFE_API_URL, callbackEnv.CAT_CAFE_API_URL);
        assert.equal(Object.hasOwn(env, 'CAT_CAFE_INVOCATION_ID'), false, 'credential files remain authoritative');
        assert.equal(Object.hasOwn(env, 'CAT_CAFE_CALLBACK_TOKEN'), false);
      }
      assert.deepEqual(base, before);
    });
  }

  it('only injects known callback env keys, ignores extras', () => {
    const base = [{ name: 'cat-cafe-collab', command: 'node', args: [], env: [] }];
    const envWithExtras = { ...CALLBACK_ENV, RANDOM_KEY: 'should-not-appear' };

    const result = materializeSessionMcpServers(base, envWithExtras);
    const names = result[0].env.map((e) => e.name);
    assert.ok(!names.includes('RANDOM_KEY'), 'Unknown keys should not be injected');
    assert.ok(names.includes('CAT_CAFE_API_URL'), 'Known keys should be injected');
  });
});

describe('callbackEnvDiagnostic', () => {
  it('reports present keys as true', () => {
    const diag = callbackEnvDiagnostic(CALLBACK_ENV);
    assert.equal(diag.hasApiUrl, true);
    assert.equal(diag.hasInvocationId, true);
    assert.equal(diag.hasCallbackToken, true);
    assert.equal(diag.hasThreadId, true);
  });

  it('reports missing keys as false', () => {
    const diag = callbackEnvDiagnostic({});
    assert.equal(diag.hasApiUrl, false);
    assert.equal(diag.hasInvocationId, false);
    assert.equal(diag.hasCallbackToken, false);
    assert.equal(diag.hasThreadId, false);
  });

  it('handles undefined', () => {
    const diag = callbackEnvDiagnostic(undefined);
    assert.equal(diag.hasApiUrl, false);
  });
});
