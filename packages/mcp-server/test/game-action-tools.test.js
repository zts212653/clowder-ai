import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('game action MCP tool observability', () => {
  let originalEnv;
  let originalFetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3004';
    process.env.CAT_CAFE_USER_ID = 'user-1';
    process.env.CAT_CAFE_CAT_ID = 'opencode';
    process.env.CAT_CAFE_INVOCATION_ID = 'inv-game-123';
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
  });

  test('handleSubmitGameAction sends cat and invocation correlation headers', async () => {
    const { handleSubmitGameAction } = await import('../dist/tools/game-action-tools.js');

    let capturedOptions;
    globalThis.fetch = async (_url, options) => {
      capturedOptions = options;
      return {
        ok: true,
        status: 200,
        json: async () => ({ accepted: true }),
      };
    };

    const result = await handleSubmitGameAction({
      gameId: 'game-1',
      round: 1,
      phase: 'night_wolf',
      seat: 2,
      action: 'kill',
      target: 1,
      nonce: 'nonce-1',
    });

    assert.equal(result.isError, undefined);
    assert.equal(capturedOptions.headers['x-cat-cafe-user'], 'user-1');
    assert.equal(capturedOptions.headers['x-cat-id'], 'opencode');
    assert.equal(capturedOptions.headers['x-callback-invocation-id'], 'inv-game-123');
  });
});
