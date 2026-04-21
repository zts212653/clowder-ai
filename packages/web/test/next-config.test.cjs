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

describe('next.config rewrites', () => {
  it('proxies /api, /socket.io, and /uploads to default API port', async () => {
    await withEnv({}, async (config) => {
      const rewrites = await config.rewrites();
      assert.deepEqual(rewrites, [
        { source: '/api/:path*', destination: 'http://localhost:3004/api/:path*' },
        { source: '/socket.io/:path*', destination: 'http://localhost:3004/socket.io/:path*' },
        { source: '/uploads/:path*', destination: 'http://localhost:3004/uploads/:path*' },
      ]);
    });
  });

  it('respects NEXT_PUBLIC_API_URL', async () => {
    await withEnv({ NEXT_PUBLIC_API_URL: 'http://myhost:9000' }, async (config) => {
      const rewrites = await config.rewrites();
      assert.equal(rewrites[0].destination, 'http://myhost:9000/api/:path*');
      assert.equal(rewrites[1].destination, 'http://myhost:9000/socket.io/:path*');
      assert.equal(rewrites[2].destination, 'http://myhost:9000/uploads/:path*');
    });
  });

  it('respects API_SERVER_PORT', async () => {
    await withEnv({ API_SERVER_PORT: '4000' }, async (config) => {
      const rewrites = await config.rewrites();
      assert.equal(rewrites[0].destination, 'http://localhost:4000/api/:path*');
    });
  });

  it('respects FRONTEND_PORT (API = frontend + 1)', async () => {
    await withEnv({ FRONTEND_PORT: '5000' }, async (config) => {
      const rewrites = await config.rewrites();
      assert.equal(rewrites[0].destination, 'http://localhost:5001/api/:path*');
    });
  });
});
