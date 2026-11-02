/**
 * F202 C1 clause 1+2 — the configuration authority must be carrier-neutral.
 *
 * WHY THIS EXISTS (plan §8.6 step 4): the in-process module carrier has to hand a plugin its
 * `FeatureContext`, whose `config` and `secrets` are **two separate namespaces**
 * (plugin-sdk@0.1.0-beta.11 `feature-context.d.ts` `FeatureContext`). The contract says that
 * carrier reuses the already-landed fail-closed projection "原样" rather than growing a second
 * authority — but today's only entry point, `projectManifestConfigurationEnv`, flattens every
 * declared field into one `Record<string, string>` env bag. A secret and a string field come out
 * indistinguishable, so a module carrier built on it could only serve one namespace, or would
 * have to re-derive `kind` and thereby fork the authority.
 *
 * So the fail-closed decision is separated from its *delivery*:
 *   - `resolveManifestConfiguration` answers the carrier-neutral question — which declared fields
 *     may this instance actually read, with which kind, at which value — and applies the same
 *     rules (protocol namespace / required-value).
 *   - `projectManifestConfigurationEnv` stays exactly what it was: that resolution flattened into
 *     the child's environment. The stdio carrier's observable behavior must not move, which is
 *     what the parity case below pins.
 *
 * Carrier-specific admission is itself a clause-1 violation, so rule 1 (`CLOWDER_` is the Host's
 * protocol namespace) stays a manifest-level refusal rather than an env-only one: the same
 * manifest must be admitted or refused identically no matter which carrier loads it.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ManifestConfigurationProjectionError,
  projectManifestConfigurationEnv,
  resolveManifestConfiguration,
} from '../dist/domains/plugin/manifest-configuration-projection.js';

const INSTANCE_ID = 'instance-carrier-neutral';

function manifestWith(configuration) {
  return { configuration };
}

/** A configuration port backed by two plain maps, for configuration and secret resolution. */
function port({ config = {}, secrets = {} } = {}) {
  return {
    readConfig: async (_instanceId, key) => config[key],
    readSecret: async (_instanceId, key) => secrets[key],
  };
}

function input({ configuration, store }) {
  return {
    pluginInstanceId: INSTANCE_ID,
    manifest: manifestWith(configuration),
    configuration: port(store),
  };
}

const BOT_TOKEN = { key: 'BOT_TOKEN', label: 'Bot token', kind: 'secret', required: true };
const API_BASE = { key: 'API_BASE', label: 'API base', kind: 'string', required: false };

describe('F202 C1 — carrier-neutral configuration authority', () => {
  test('required operations are actions, never runtime config values or store reads', async () => {
    const reads = [];
    const args = {
      pluginInstanceId: INSTANCE_ID,
      manifest: manifestWith([
        { key: 'login', label: 'Sign in', kind: 'operation', required: true, target: ['token'], actions: [] },
        { key: 'token', label: 'Token', kind: 'secret', required: false },
      ]),
      configuration: {
        async readConfig(_id, key) {
          reads.push(key);
          throw new Error('operation cannot be read');
        },
        async readSecret(_id, key) {
          reads.push(key);
          return 'configured-token';
        },
      },
    };
    assert.deepEqual(await resolveManifestConfiguration(args), [
      { key: 'token', kind: 'secret', value: 'configured-token' },
    ]);
    assert.deepEqual(await projectManifestConfigurationEnv(args), { token: 'configured-token' });
    assert.deepEqual(reads, ['token', 'token']);
  });

  test('resolution keeps each field kind, so config and secrets stay separable namespaces', async () => {
    const resolved = await resolveManifestConfiguration(
      input({
        configuration: [BOT_TOKEN, API_BASE],
        store: { secrets: { BOT_TOKEN: 'tok-1' }, config: { API_BASE: 'https://example.test' } },
      }),
    );

    assert.deepEqual(
      resolved.map((field) => ({ key: field.key, kind: field.kind, value: field.value })),
      [
        { key: 'BOT_TOKEN', kind: 'secret', value: 'tok-1' },
        { key: 'API_BASE', kind: 'string', value: 'https://example.test' },
      ],
      'a module carrier must be able to route BOT_TOKEN to secrets.get and API_BASE to config.get',
    );
  });

  test('env projection is exactly the resolution flattened — the stdio carrier does not move', async () => {
    const args = input({
      configuration: [BOT_TOKEN, API_BASE],
      store: { secrets: { BOT_TOKEN: 'tok-1' }, config: { API_BASE: 'https://example.test' } },
    });

    const resolved = await resolveManifestConfiguration(args);
    const env = await projectManifestConfigurationEnv(args);

    assert.deepEqual(env, { BOT_TOKEN: 'tok-1', API_BASE: 'https://example.test' });
    assert.deepEqual(env, Object.fromEntries(resolved.map((field) => [field.key, field.value])));
  });

  test('rule 1 refuses the Host protocol namespace at the manifest level, for every carrier', async () => {
    const args = input({
      configuration: [{ key: 'CLOWDER_PLUGIN_ID', label: 'Identity', kind: 'string', required: false }],
      store: {},
    });

    await assert.rejects(
      resolveManifestConfiguration(args),
      (error) => error instanceof ManifestConfigurationProjectionError && error.failure.reason === 'protocol_namespace',
    );
    await assert.rejects(
      projectManifestConfigurationEnv(args),
      (error) => error instanceof ManifestConfigurationProjectionError && error.failure.reason === 'protocol_namespace',
    );
  });

  test('required field that has no effective value', async () => {
    await assert.rejects(
      resolveManifestConfiguration(input({ configuration: [BOT_TOKEN], store: {} })),
      (error) => error instanceof ManifestConfigurationProjectionError && error.failure.reason === 'value_unavailable',
    );
  });

  test('conditional requirement uses the referenced effective value, not the unconditional required flag', async () => {
    const fields = [
      { key: 'mode', label: 'Mode', kind: 'select', required: false, default: 'webhook' },
      {
        key: 'verificationToken',
        label: 'Token',
        kind: 'secret',
        required: true,
        requiredWhen: { key: 'mode', value: ['webhook', 'hybrid'] },
      },
    ];
    await assert.rejects(
      resolveManifestConfiguration(input({ configuration: fields, store: {} })),
      (error) => error instanceof ManifestConfigurationProjectionError && error.failure.reason === 'value_unavailable',
    );
    assert.deepEqual(
      await resolveManifestConfiguration(
        input({
          configuration: fields,
          store: { config: { mode: 'polling' } },
        }),
      ),
      [{ key: 'mode', kind: 'select', value: 'polling' }],
    );
  });

  test('boolean conditions compare the serialized effective scalar', async () => {
    const fields = [
      { key: 'enabled', label: 'Enabled', kind: 'boolean', required: false, default: false },
      {
        key: 'reason',
        label: 'Reason',
        kind: 'string',
        required: false,
        requiredWhen: { key: 'enabled', value: false },
      },
    ];
    await assert.rejects(
      resolveManifestConfiguration(input({ configuration: fields, store: {} })),
      (error) => error instanceof ManifestConfigurationProjectionError && error.failure.reason === 'value_unavailable',
    );
    assert.deepEqual(
      await resolveManifestConfiguration(
        input({
          configuration: fields,
          store: { config: { enabled: true } },
        }),
      ),
      [{ key: 'enabled', kind: 'boolean', value: 'true' }],
    );
  });
});
