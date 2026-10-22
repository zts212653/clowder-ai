import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ENV_VARS, isEditableEnvVarName } from '../../dist/config/env-registry.js';
import { isTrustedHostCompatibilityEnabled } from '../../dist/config/trusted-host-compatibility.js';

const keys = ['CAT_CAFE_TRUSTED_HOST_COMPATIBILITY', 'CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE'];
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of keys)
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
});

test('Windows ACP policy accepts a separate explicit mode with priority over the legacy alias', () => {
  process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY = '0';
  process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE = 'trusted-host';
  assert.equal(isTrustedHostCompatibilityEnabled(), true);
  process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY = '1';
  process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE = 'strict';
  assert.equal(isTrustedHostCompatibilityEnabled(), false);
  delete process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE;
  assert.equal(isTrustedHostCompatibilityEnabled(), true);
  process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE = 'typo';
  assert.throws(isTrustedHostCompatibilityEnabled, /CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE/);
});

test('separate policy is startup-only and cannot be edited through Hub', () => {
  const entry = ENV_VARS.find((entry) => entry.name === 'CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE');
  assert.equal(entry?.defaultValue, 'strict');
  assert.equal(entry?.restartRequired, true);
  assert.equal(isEditableEnvVarName(entry?.name), false);
});
