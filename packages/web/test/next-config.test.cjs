const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, it } = require('node:test');

const configPath = path.resolve(__dirname, '../next.config.js');
const ENV_KEYS = ['NEXT_PUBLIC_API_URL', 'API_SERVER_PORT', 'FRONTEND_PORT'];

function withEnv(overrides, run) {
  const snapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, overrides);
    delete require.cache[configPath];
    return run(require(configPath));
  } finally {
    delete require.cache[configPath];
    for (const key of ENV_KEYS) {
      const value = snapshot[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('next.config uploads rewrite', () => {
  it('falls back to the default API port when env vars are unset', async () => {
    await withEnv({}, async (config) => {
      const rewrites = await config.rewrites();
      assert.deepEqual(
        rewrites.find((entry) => entry.source === '/uploads/:path*'),
        {
          source: '/uploads/:path*',
          destination: 'http://localhost:3004/uploads/:path*',
        },
      );
    });
  });
});
