/**
 * Unit tests for acp-session-env: per-invocation callback env materialization.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { materializeSessionMcpServers, callbackEnvDiagnostic } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/acp-session-env.js'
);

const CALLBACK_ENV = {
  CAT_CAFE_API_URL: 'http://localhost:3004',
  CAT_CAFE_INVOCATION_ID: 'inv-abc',
  CAT_CAFE_CALLBACK_TOKEN: 'tok-xyz',
  CAT_CAFE_USER_ID: 'user-1',
  CAT_CAFE_CAT_ID: 'gemini',
  CAT_CAFE_SIGNAL_USER: 'gemini',
};

describe('materializeSessionMcpServers', () => {
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

    const memoryEnv = Object.fromEntries(result[1].env.map((e) => [e.name, e.value]));
    assert.equal(memoryEnv.KEEP, 'yes', 'Existing env preserved');
    assert.equal(memoryEnv.CAT_CAFE_INVOCATION_ID, 'inv-abc');
  });

  it('injects into exact "cat-cafe" name (not just cat-cafe-* prefixed)', () => {
    const base = [
      { name: 'cat-cafe', command: 'node', args: ['cat-cafe.js'], env: [{ name: 'EXISTING', value: 'keep' }] },
    ];

    const result = materializeSessionMcpServers(base, CALLBACK_ENV);
    const envMap = Object.fromEntries(result[0].env.map((e) => [e.name, e.value]));
    assert.equal(envMap.CAT_CAFE_API_URL, 'http://localhost:3004');
    assert.equal(envMap.CAT_CAFE_INVOCATION_ID, 'inv-abc');
    assert.equal(envMap.EXISTING, 'keep', 'Existing env preserved');
  });

  it('does not modify non-cat-cafe servers', () => {
    const base = [
      { name: 'playwright', command: 'npx', args: ['@playwright/mcp'], env: [] },
      { name: 'cat-cafe-signals', command: 'node', args: ['signals.js'], env: [] },
    ];

    const result = materializeSessionMcpServers(base, CALLBACK_ENV);
    assert.deepStrictEqual(result[0].env, [], 'playwright should be untouched');
    assert.ok(result[1].env.length > 0, 'cat-cafe-signals should get env');
  });

  it('does not inject into servers with coincidental cat-cafe prefix (e.g. cat-cafeteria)', () => {
    const base = [
      { name: 'cat-cafeteria', command: 'node', args: ['cafeteria.js'], env: [] },
      { name: 'cat-cafe-collab', command: 'node', args: ['collab.js'], env: [] },
    ];

    const result = materializeSessionMcpServers(base, CALLBACK_ENV);
    assert.deepStrictEqual(result[0].env, [], 'cat-cafeteria should NOT get callback env');
    assert.ok(result[1].env.length > 0, 'cat-cafe-collab should get callback env');
  });

  it('does not modify HTTP/SSE servers even with cat-cafe prefix', () => {
    const base = [{ type: 'http', name: 'cat-cafe-http', url: 'http://localhost', headers: [] }];

    const result = materializeSessionMcpServers(base, CALLBACK_ENV);
    assert.deepStrictEqual(result, base, 'HTTP server should pass through unchanged');
  });

  it('returns base array as-is when no callbackEnv', () => {
    const base = [{ name: 'cat-cafe-collab', command: 'node', args: [], env: [] }];
    const result = materializeSessionMcpServers(base, undefined);
    assert.strictEqual(result, base, 'Should return same reference');
  });

  it('returns base array as-is when callbackEnv is empty', () => {
    const base = [{ name: 'cat-cafe-collab', command: 'node', args: [], env: [] }];
    const result = materializeSessionMcpServers(base, {});
    assert.strictEqual(result, base, 'Should return same reference');
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
    const envMap = Object.fromEntries(result[0].env.map((e) => [e.name, e.value]));
    assert.equal(envMap.CAT_CAFE_API_URL, 'http://localhost:3004', 'Should overwrite placeholder');
    assert.equal(envMap.OTHER, 'keep', 'Non-callback env preserved');
  });

  it('does not mutate original servers', () => {
    const base = [{ name: 'cat-cafe-collab', command: 'node', args: [], env: [{ name: 'A', value: 'B' }] }];
    const original = JSON.parse(JSON.stringify(base));

    materializeSessionMcpServers(base, CALLBACK_ENV);
    assert.deepStrictEqual(base, original, 'Input should not be mutated');
  });

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
  });

  it('reports missing keys as false', () => {
    const diag = callbackEnvDiagnostic({});
    assert.equal(diag.hasApiUrl, false);
    assert.equal(diag.hasInvocationId, false);
    assert.equal(diag.hasCallbackToken, false);
  });

  it('handles undefined', () => {
    const diag = callbackEnvDiagnostic(undefined);
    assert.equal(diag.hasApiUrl, false);
  });
});
