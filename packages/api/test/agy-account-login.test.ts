import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareAgyAccountLogin } from '../src/scripts/agy-account-login.js';

test('official account login uses the selected file store and cannot inherit another billing identity', () => {
  const home = mkdtempSync(join(tmpdir(), 'f320-agy-login-'));
  const saved = { ...process.env };
  try {
    mkdirSync(join(home, '.gemini/antigravity-cli'), { recursive: true, mode: 0o700 });
    Object.assign(process.env, {
      AGY_ADC_AUTH: 'true',
      AGY_ACCOUNT: 'foreign',
      AGY_LLM_GATEWAY_API_KEY: 'fake-foreign',
      GEMINI_API_KEY: 'fake-foreign',
      GOOGLE_APPLICATION_CREDENTIALS: '/foreign',
      HTTPS_PROXY: 'http://proxy.test:1234',
    });
    const launch = prepareAgyAccountLogin(home, '/usr/bin/true');
    assert.equal(launch.cwd, home);
    assert.equal(launch.env.HOME, home);
    assert.equal(launch.env.SSH_TTY, 'cat-cafe-file-auth');
    assert.equal(launch.env.HTTPS_PROXY, 'http://proxy.test:1234');
    for (const key of [
      'AGY_ADC_AUTH',
      'AGY_ACCOUNT',
      'AGY_LLM_GATEWAY_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
    ])
      assert.equal(launch.env[key], undefined, key);
  } finally {
    process.env = saved;
    rmSync(home, { recursive: true, force: true });
  }
});
