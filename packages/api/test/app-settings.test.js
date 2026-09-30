/**
 * App-setting eligibility tests.
 *
 * app-settings.ts is the single truth source shared by the boot loader
 * (project-env-loader) and PATCH persistence (routes/config). It must stay
 * fail-closed: a key becoming hot-updatable must never make it restorable from
 * the operator-writable config-root .env.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { APP_SETTING_CONFIG_KEYS, appSettingEnvKeys, EXTRA_APP_SETTING_ENV_KEYS } from '../dist/config/app-settings.js';
import { configStore } from '../dist/config/ConfigStore.js';

function configStoreEnvKeys() {
  return new Set(
    configStore
      .listUpdatableKeys()
      .map((key) => configStore.getEnvKey(key))
      .filter(Boolean),
  );
}

describe('appSettingEnvKeys', () => {
  it('includes the Hub-persisted app settings', () => {
    const keys = appSettingEnvKeys();
    for (const name of [
      'DEFAULT_CAT_ID',
      'UI_BUBBLE_CLI_OUTPUT_DEFAULT',
      'UI_BUBBLE_THINKING_DEFAULT',
      'PROMPT_CAPTURE',
      'PROMPT_CAPTURE_CATS',
    ]) {
      assert.ok(keys.has(name), `${name} must be eligible for boot restore and .env persistence`);
    }
  });

  it('excludes capability and permission env keys', () => {
    const keys = appSettingEnvKeys();
    for (const name of [
      'CONNECTOR_GATEWAY_AUTOSTART',
      'CAT_CODEX_SANDBOX_MODE',
      'CAT_CODEX_APPROVAL_POLICY',
      'CODEX_AUTH_MODE',
      'CAT_CODEX_EXEC_MODEL',
      'CAT_CODEX_PASS_MODEL_ARG',
    ]) {
      assert.equal(keys.has(name), false, `${name} must stay launcher-owned`);
    }
  });

  it('derives env names only from the explicit ConfigStore allowlist', () => {
    const keys = appSettingEnvKeys();
    const allowlistedEnvKeys = new Set(
      [...APP_SETTING_CONFIG_KEYS].map((key) => configStore.getEnvKey(key)).filter(Boolean),
    );
    for (const envKey of configStoreEnvKeys()) {
      assert.equal(
        keys.has(envKey),
        allowlistedEnvKeys.has(envKey),
        `${envKey} eligibility must come from APP_SETTING_CONFIG_KEYS, not from being hot-updatable`,
      );
    }
  });

  it('never makes a high-risk ConfigStore key restorable', () => {
    const keys = appSettingEnvKeys();
    const highRisk = configStore.listUpdatableKeys().filter((key) => configStore.getRiskLevel(key) === 'high');
    assert.ok(highRisk.length > 0, 'sanity: ConfigStore must still declare high-risk keys');
    for (const key of highRisk) {
      const envKey = configStore.getEnvKey(key);
      assert.ok(envKey, `high-risk key ${key} must map to an env key`);
      assert.equal(keys.has(envKey), false, `${envKey} is high-risk and must not be restorable`);
    }
  });

  it('keeps every allowlisted ConfigStore key resolvable', () => {
    for (const key of APP_SETTING_CONFIG_KEYS) {
      assert.ok(configStore.listUpdatableKeys().includes(key), `${key} must still be an updatable ConfigStore key`);
      assert.ok(configStore.getEnvKey(key), `${key} must still map to an env key`);
    }
  });

  it('keeps every extra app-setting env key out of the ConfigStore mapping', () => {
    // EXTRA keys exist precisely because no ConfigStore key covers them. If one
    // gains a mapping, reconcile the two lists instead of duplicating the name.
    const mapped = configStoreEnvKeys();
    for (const name of EXTRA_APP_SETTING_ENV_KEYS) {
      assert.equal(mapped.has(name), false, `${name} now has a ConfigStore mapping; reconcile app-settings.ts`);
    }
  });
});
