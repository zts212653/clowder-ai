import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeConfiguredDefaults } from '../dist/routes/native-claude-defaults.js';

const models = [
  { value: 'opus', label: 'Opus', resolvedModel: 'claude-opus-5-5' },
  { value: 'sonnet', label: 'Sonnet', resolvedModel: 'claude-sonnet-5' },
];

test('Claude projects env and per-model settings without treating the first catalog entry as a default', () => {
  const settings = {
    env: { ANTHROPIC_MODEL: 'claude-opus-5-5[1M]', CLAUDE_CODE_EFFORT_LEVEL: 'xhigh' },
    modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } },
  };
  const result = claudeConfiguredDefaults(settings, models, undefined, {});
  assert.equal(result.defaultModel, 'claude-opus-5-5[1M]');
  assert.equal(result.defaultModelLabel, 'Opus');
  assert.equal(result.defaultEffort, 'xhigh');
  assert.equal(result.defaultEffortSource, 'tool_config');
  assert.equal(
    claudeConfiguredDefaults({ modelSettings: settings.modelSettings }, models, undefined, {}).defaultEffort,
    undefined,
  );
});

test('Claude keeps native defaults apart from a selected model and resolves each model effort', () => {
  const result = claudeConfiguredDefaults(
    {
      model: 'opus',
      effortLevel: 'low',
      modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' }, 'claude-sonnet-5': { effortLevel: 'medium' } },
    },
    models,
    'sonnet',
    {},
  );
  assert.equal(result.defaultModel, 'opus');
  assert.equal(result.defaultEffort, 'high');
  assert.equal(result.selectedModel, 'sonnet');
  assert.equal(result.selectedEffort, 'medium');
});

test('Claude retains explicit env auto instead of guessing a numeric model effort', () => {
  const result = claudeConfiguredDefaults({ model: 'opus', effortLevel: 'high' }, models, undefined, {
    CLAUDE_CODE_EFFORT_LEVEL: 'auto',
  });
  assert.equal(result.defaultEffort, 'auto');
});
