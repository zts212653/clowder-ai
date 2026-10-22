import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedOAuthEnv } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-launch-env.js';

const proxies = {
  HTTP_PROXY: 'http://proxy.example:8080',
  http_proxy: 'http://lowercase.example:8081',
  HTTPS_PROXY: 'http://proxy.example:8082',
  https_proxy: 'http://lowercase.example:8083',
  ALL_PROXY: 'socks5://proxy.example:1080',
  all_proxy: 'socks5://lowercase.example:1081',
  NO_PROXY: 'localhost,127.0.0.1,::1,.internal.example',
  no_proxy: '',
};

function withEnv(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('isolated OAuth preserves configured proxy values without importing account or host authority', () => {
  withEnv(
    {
      ...proxies,
      GEMINI_API_KEY: 'synthetic-api-key',
      GOOGLE_APPLICATION_CREDENTIALS: '/synthetic/credentials.json',
      CAT_CAFE_CALLBACK_TOKEN: 'synthetic-callback-token',
      AGY_UNRELATED_SECRET: 'synthetic-unrelated-secret',
      NODE_OPTIONS: '--inspect',
    },
    () => {
      const env = isolatedOAuthEnv('/isolated/profile');
      for (const [key, value] of Object.entries(proxies)) assert.equal(env[key], value, key);
      assert.equal(env.HOME, '/isolated/profile');
      assert.equal(env.GEMINI_API_KEY, null);
      assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, null);
      assert.equal(env.CAT_CAFE_CALLBACK_TOKEN, null);
      assert.equal(env.AGY_UNRELATED_SECRET, undefined);
      assert.equal(env.NODE_OPTIONS, undefined);
    },
  );
});

test('isolated OAuth leaves absent proxies unset', () => {
  withEnv(Object.fromEntries(Object.keys(proxies).map((key) => [key, undefined])), () => {
    const env = isolatedOAuthEnv('/isolated/profile');
    for (const key of Object.keys(proxies)) assert.equal(env[key], undefined, key);
  });
});
