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
 *     may this instance actually read, with which kind, at which value — and applies all three
 *     rules (protocol namespace / grant / required-value).
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

/** A configuration port backed by two plain maps, so a test can separate store from grant. */
function port({ config = {}, secrets = {} } = {}) {
  return {
    readConfig: async (_instanceId, key) => config[key],
    readSecret: async (_instanceId, key) => secrets[key],
  };
}

function input({ configuration, grants, store }) {
  return {
    pluginInstanceId: INSTANCE_ID,
    manifest: manifestWith(configuration),
    effectiveGrants: grants,
    configuration: port(store),
  };
}

const BOT_TOKEN = { key: 'BOT_TOKEN', label: 'Bot token', kind: 'secret', required: true };
const API_BASE = { key: 'API_BASE', label: 'API base', kind: 'string', required: false };

describe('F202 C1 — carrier-neutral configuration authority', () => {
  test('resolution keeps each field kind, so config and secrets stay separable namespaces', async () => {
    const resolved = await resolveManifestConfiguration(
      input({
        configuration: [BOT_TOKEN, API_BASE],
        grants: ['secret.read', 'plugin.config.read'],
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
      grants: ['secret.read', 'plugin.config.read'],
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
      grants: ['plugin.config.read'],
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

  test('rule 2 omits an ungranted optional field even when a value is stored', async () => {
    const resolved = await resolveManifestConfiguration(
      input({
        configuration: [API_BASE],
        grants: [],
        store: { config: { API_BASE: 'https://example.test' } },
      }),
    );

    assert.deepEqual(resolved, [], 'no grant means the value is never read into any carrier');
  });

  test('rule 3 outranks rule 2: an ungranted required field refuses rather than starting blind', async () => {
    await assert.rejects(
      resolveManifestConfiguration(
        input({ configuration: [BOT_TOKEN], grants: [], store: { secrets: { BOT_TOKEN: 'tok-1' } } }),
      ),
      (error) =>
        error instanceof ManifestConfigurationProjectionError &&
        error.failure.reason === 'grant_unavailable' &&
        error.failure.grant === 'secret.read',
    );
  });

  test('rule 3 refuses a granted required field that has no effective value', async () => {
    await assert.rejects(
      resolveManifestConfiguration(input({ configuration: [BOT_TOKEN], grants: ['secret.read'], store: {} })),
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
      resolveManifestConfiguration(
        input({ configuration: fields, grants: ['plugin.config.read', 'secret.read'], store: {} }),
      ),
      (error) => error instanceof ManifestConfigurationProjectionError && error.failure.reason === 'value_unavailable',
    );
    await assert.rejects(
      resolveManifestConfiguration(input({ configuration: fields, grants: ['plugin.config.read'], store: {} })),
      (error) => error instanceof ManifestConfigurationProjectionError && error.failure.reason === 'grant_unavailable',
    );
    assert.deepEqual(
      await resolveManifestConfiguration(
        input({
          configuration: fields,
          grants: ['plugin.config.read'],
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
      resolveManifestConfiguration(input({ configuration: fields, grants: ['plugin.config.read'], store: {} })),
      (error) => error instanceof ManifestConfigurationProjectionError && error.failure.reason === 'value_unavailable',
    );
    assert.deepEqual(
      await resolveManifestConfiguration(
        input({
          configuration: fields,
          grants: ['plugin.config.read'],
          store: { config: { enabled: true } },
        }),
      ),
      [{ key: 'enabled', kind: 'boolean', value: 'true' }],
    );
  });
});
