import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApiKeyEnv } from '../src/domains/cats/services/agents/providers/kimi-config.js';

test('the selected API account reaches current Kimi without altering its model or legacy credential channel', () => {
  const env = buildApiKeyEnv('selected-model', {
    CAT_CAFE_KIMI_API_KEY: 'fixture-api-key',
    CAT_CAFE_KIMI_BASE_URL: 'https://selected.example/v1',
  });
  assert.equal(env?.KIMI_MODEL_API_KEY, 'fixture-api-key');
  assert.equal(env?.KIMI_MODEL_BASE_URL, 'https://selected.example/v1');
  assert.equal(env?.KIMI_MODEL_NAME, 'selected-model');
  assert.equal(env?.KIMI_API_KEY, env?.KIMI_MODEL_API_KEY);
  assert.equal(env?.KIMI_BASE_URL, env?.KIMI_MODEL_BASE_URL);
});

test('current and legacy Kimi endpoint variables share the existing coding-path normalization', () => {
  const env = buildApiKeyEnv('selected-model', {
    CAT_CAFE_KIMI_API_KEY: 'fixture-api-key',
    CAT_CAFE_KIMI_BASE_URL: 'https://api.kimi.com/coding/',
  });
  assert.equal(env?.KIMI_MODEL_BASE_URL, 'https://api.kimi.com/coding/v1');
  assert.equal(env?.KIMI_BASE_URL, env?.KIMI_MODEL_BASE_URL);
});

test('native OAuth does not acquire an API credential or another billing path', () => {
  assert.equal(buildApiKeyEnv('native-model'), null);
  assert.equal(buildApiKeyEnv('native-model', {}), null);
});
