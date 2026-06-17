/**
 * Tests for buildKimiAuthEnv dual-path detection.
 *
 * Issue #939: Kimi CLI invocation fails when CAT_CAFE_KIMI_API_KEY is
 * not set. Fix: detect kimi-cli's native OAuth credential file at
 * ~/.kimi-code/credentials/kimi-code.json as a fallback.
 *
 * Detection priority (from buildKimiAuthEnv):
 *   1. CAT_CAFE_KIMI_API_KEY          → kind: 'api_key'
 *   2. CAT_CAFE_KIMI_OAUTH_TOKEN      → kind: 'oauth_token'
 *   3. ~/.kimi-code/credentials/...    → kind: 'native'
 *   4. none                            → null (caller fails with hint)
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const { buildKimiAuthEnv, KIMI_NATIVE_CREDENTIAL_REL_PATH } = await import(
  '../dist/domains/cats/services/agents/providers/kimi-config.js'
);

const NONEXISTENT_HOME = '/tmp/clowder-kimi-test-no-such-home';

function makeNativeCredentialHome() {
  const tmp = mkdtempSync(join(tmpdir(), 'kimi-auth-'));
  const credDir = join(tmp, KIMI_NATIVE_CREDENTIAL_REL_PATH.split('/').slice(0, -1).join('/'));
  mkdirSync(credDir, { recursive: true });
  writeFileSync(
    join(tmp, KIMI_NATIVE_CREDENTIAL_REL_PATH),
    JSON.stringify({ access_token: 'native-test-token', refresh_token: 'rt' }),
  );
  return tmp;
}

describe('buildKimiAuthEnv — priority order', () => {
  it('returns null when nothing is configured (no API key, no OAuth, no credential file)', () => {
    const result = buildKimiAuthEnv('kimi-code/kimi-for-coding', {}, { userHomeDir: NONEXISTENT_HOME });
    assert.equal(result, null);
  });

  it('returns null when callbackEnv is undefined and no credential file', () => {
    const result = buildKimiAuthEnv('kimi-code/kimi-for-coding', undefined, { userHomeDir: NONEXISTENT_HOME });
    assert.equal(result, null);
  });

  it('uses CAT_CAFE_KIMI_API_KEY when set (priority 1)', () => {
    const result = buildKimiAuthEnv(
      'kimi-code/kimi-for-coding',
      { CAT_CAFE_KIMI_API_KEY: 'test-key-123' },
      { userHomeDir: NONEXISTENT_HOME },
    );
    assert.ok(result);
    assert.equal(result.kind, 'api_key');
    assert.equal(result.env.KIMI_API_KEY, 'test-key-123');
    assert.ok(!('KIMI_OAUTH_TOKEN' in result.env), 'should not include oauth token');
    assert.ok(!('KIMI_CREDENTIALS_FILE' in result.env), 'should not include native credential path');
  });

  it('uses CAT_CAFE_KIMI_OAUTH_TOKEN when set (priority 2)', () => {
    const result = buildKimiAuthEnv(
      'kimi-code/kimi-for-coding',
      { CAT_CAFE_KIMI_OAUTH_TOKEN: 'test-oauth-token-456' },
      { userHomeDir: NONEXISTENT_HOME },
    );
    assert.ok(result);
    assert.equal(result.kind, 'oauth_token');
    assert.equal(result.env.KIMI_OAUTH_TOKEN, 'test-oauth-token-456');
    assert.ok(!('KIMI_API_KEY' in result.env), 'should not include api key');
  });

  it('falls back to native credential file at ~/.kimi-code/credentials/kimi-code.json (priority 3)', () => {
    const home = makeNativeCredentialHome();
    after(() => {
      // mkdtempSync auto-cleans; explicit cleanup not needed
    });
    const result = buildKimiAuthEnv('kimi-code/kimi-for-coding', {}, { userHomeDir: home });
    assert.ok(result);
    assert.equal(result.kind, 'native');
    assert.match(result.env.KIMI_CREDENTIALS_FILE, /\.kimi-code\/credentials\/kimi-code\.json$/);
    assert.equal(result.env.KIMI_CREDENTIALS_FILE, join(home, KIMI_NATIVE_CREDENTIAL_REL_PATH));
  });
});

describe('buildKimiAuthEnv — priority when multiple auth sources present', () => {
  it('API key wins over native credential file', () => {
    const home = makeNativeCredentialHome();
    const result = buildKimiAuthEnv(
      'kimi-code/kimi-for-coding',
      { CAT_CAFE_KIMI_API_KEY: 'key-wins' },
      { userHomeDir: home },
    );
    assert.equal(result.kind, 'api_key');
    assert.equal(result.env.KIMI_API_KEY, 'key-wins');
  });

  it('OAuth token wins over native credential file', () => {
    const home = makeNativeCredentialHome();
    const result = buildKimiAuthEnv(
      'kimi-code/kimi-for-coding',
      { CAT_CAFE_KIMI_OAUTH_TOKEN: 'oauth-wins' },
      { userHomeDir: home },
    );
    assert.equal(result.kind, 'oauth_token');
    assert.equal(result.env.KIMI_OAUTH_TOKEN, 'oauth-wins');
  });

  it('API key wins over OAuth token (when both are set)', () => {
    const result = buildKimiAuthEnv(
      'kimi-code/kimi-for-coding',
      { CAT_CAFE_KIMI_API_KEY: 'k', CAT_CAFE_KIMI_OAUTH_TOKEN: 't' },
      { userHomeDir: NONEXISTENT_HOME },
    );
    assert.equal(result.kind, 'api_key');
    assert.equal(result.env.KIMI_API_KEY, 'k');
  });
});

describe('buildKimiAuthEnv — common env fields', () => {
  it('always sets KIMI_BASE_URL, KIMI_MODEL_NAME, KIMI_MODEL_MAX_CONTEXT_SIZE', () => {
    const result = buildKimiAuthEnv(
      'kimi-code/kimi-for-coding',
      { CAT_CAFE_KIMI_API_KEY: 'k', CAT_CAFE_KIMI_BASE_URL: 'https://example.test/v1' },
      { userHomeDir: NONEXISTENT_HOME },
    );
    assert.equal(result.env.KIMI_BASE_URL, 'https://example.test/v1');
    assert.equal(result.env.KIMI_MODEL_NAME, 'kimi-code/kimi-for-coding');
    assert.match(result.env.KIMI_MODEL_MAX_CONTEXT_SIZE, /^\d+$/);
  });

  it('respects KIMI_MODEL_MAX_CONTEXT_SIZE override from callbackEnv', () => {
    const result = buildKimiAuthEnv(
      'kimi-code/kimi-for-coding',
      { CAT_CAFE_KIMI_API_KEY: 'k', KIMI_MODEL_MAX_CONTEXT_SIZE: '999000' },
      { userHomeDir: NONEXISTENT_HOME },
    );
    assert.equal(result.env.KIMI_MODEL_MAX_CONTEXT_SIZE, '999000');
  });
});
