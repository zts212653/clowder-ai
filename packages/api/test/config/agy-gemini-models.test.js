import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { AGY_GEMINI_DEFAULT_MODEL_BY_CAT_ID, normalizeAgyGeminiModelSelector, resolveAgyGeminiDefaultModel } =
  await import('../../dist/config/agy-gemini-models.js');

describe('AGY Gemini legacy selector compatibility', () => {
  test('keeps each legacy cat default identity unchanged', () => {
    assert.equal(AGY_GEMINI_DEFAULT_MODEL_BY_CAT_ID.get('gemini'), 'Gemini 3.1 Pro (High)');
    assert.equal(AGY_GEMINI_DEFAULT_MODEL_BY_CAT_ID.get('gemini25'), 'Gemini 3.5 Flash (High)');
    assert.equal(AGY_GEMINI_DEFAULT_MODEL_BY_CAT_ID.get('gemini35'), 'Gemini 3.6 Flash (High)');
    assert.equal(AGY_GEMINI_DEFAULT_MODEL_BY_CAT_ID.get('gemini38'), 'Gemini 3.8 Flash (High)');
  });

  test('maps only same-model 3.8 thinking tiers', () => {
    assert.equal(normalizeAgyGeminiModelSelector('gemini-3.8-flash-high'), 'Gemini 3.8 Flash (High)');
    assert.equal(normalizeAgyGeminiModelSelector('gemini-3.8-flash-medium'), 'Gemini 3.8 Flash (Medium)');
    assert.equal(normalizeAgyGeminiModelSelector('gemini-3.8-flash-low'), 'Gemini 3.8 Flash (Low)');
  });

  test('does not silently replace explicit cross-model or cross-tier choices', () => {
    assert.equal(resolveAgyGeminiDefaultModel('gemini', 'Gemini 3.1 Pro (High)'), undefined);
    assert.equal(resolveAgyGeminiDefaultModel('gemini', 'Gemini 3.1 Pro (Low)'), undefined);
    assert.equal(resolveAgyGeminiDefaultModel('gemini25', 'Gemini 3.5 Flash (Medium)'), undefined);
    assert.equal(resolveAgyGeminiDefaultModel('gemini38', 'Gemini 3.8 Flash (Medium)'), undefined);
    assert.equal(resolveAgyGeminiDefaultModel('gemini38', 'gemini-3.8-flash-medium'), 'Gemini 3.8 Flash (Medium)');
  });

  test('leaves Claude and GPT-OSS selectors on their explicit model paths', () => {
    assert.equal(normalizeAgyGeminiModelSelector('claude-sonnet-4-6'), 'claude-sonnet-4-6');
    assert.equal(normalizeAgyGeminiModelSelector('claude-opus-4-6-thinking'), 'claude-opus-4-6-thinking');
    assert.equal(normalizeAgyGeminiModelSelector('gpt-oss-120b-medium'), 'gpt-oss-120b-medium');
  });

  test('repeated reads are stable', () => {
    for (let i = 0; i < 2; i++) {
      assert.equal(resolveAgyGeminiDefaultModel('gemini38', 'gemini-3.8-flash-low'), 'Gemini 3.8 Flash (Low)');
      assert.equal(resolveAgyGeminiDefaultModel('gemini', 'Gemini 3.1 Pro (High)'), undefined);
    }
  });
});
