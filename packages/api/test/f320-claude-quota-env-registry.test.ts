import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEnvSummary, buildSystemEnvSummary, ENV_VARS, isEditableEnvVarName } from '../src/config/env-registry.js';

test('native Claude quota identity controls stay internal and cannot become editable app settings', (t) => {
  const values = {
    CLAUDE_SECURESTORAGE_CONFIG_DIR: 'F320_TEST_PRIVATE_STORAGE_ROOT',
    CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '9',
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
  };
  for (const [name, value] of Object.entries(values)) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    process.env[name] = value;
    const definition = ENV_VARS.find((entry) => entry.name === name);
    assert.ok(definition, `${name} must be registered at its real consumer`);
    assert.equal(definition.hubVisible, false);
    assert.equal(definition.runtimeEditable, false);
    assert.equal(isEditableEnvVarName(name), false);
    assert.equal(definition.exampleRecommended, false);
  }
  const transport = ENV_VARS.find((entry) => entry.name === 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR');
  assert.equal(transport?.sensitive, true, 'private credential transport metadata must remain masked');
  for (const summary of [buildEnvSummary(), buildSystemEnvSummary()]) {
    assert.equal(
      summary.some((entry) => Object.hasOwn(values, entry.name)),
      false,
    );
    assert.equal(JSON.stringify(summary).includes(values.CLAUDE_SECURESTORAGE_CONFIG_DIR), false);
  }
});
