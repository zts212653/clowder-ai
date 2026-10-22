/**
 * configurationVariants (contract 0.2.0) — Host consumption paths (design §3.1–§3.4).
 *
 * WHY THIS EXISTS: the feishu plugin must make its Verification Token required only in
 * webhook mode. The contract package owns every semantic (branch selection, defaults,
 * requiredness, validation); the Host only consumes. These tests pin the four Host
 * consumers against the feishu-shaped manifest so a regression in any one of them —
 * startup projection, module settings, save/readiness, console field projection —
 * fails here instead of reaching a real plugin install.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createModuleSettingsHost } from '../dist/domains/plugin/builtin-runtime/carriers/module-plugin-settings.js';
import { MemoryPluginInventoryStore } from '../dist/domains/plugin/host-inventory/index.js';
import { HostPluginConfigurationService } from '../dist/domains/plugin/manager/plugin-manager-configuration.js';
import {
  ManifestConfigurationProjectionError,
  resolveManifestConfiguration,
} from '../dist/domains/plugin/manifest-configuration-projection.js';
import { readPluginConfig, writePluginConfig } from '../dist/domains/plugin/plugin-config-store.js';

const INSTANCE_ID = 'pi-feishu-variants';
const PLUGIN_ID = 'dev.clowder.feishu';
const GRANTS = ['plugin.config.read', 'secret.read'];

/** The feishu-shaped target declaration (brief §47-64): Token required iff webhook. */
function feishuManifest(overrides = {}) {
  return {
    pluginId: PLUGIN_ID,
    version: '1.0.0',
    contractVersion: '0.2.0',
    name: 'Feishu',
    features: [
      { id: 'messaging', name: 'Messaging', capabilities: ['plugin.config.read', 'secret.read'], resources: [] },
    ],
    runtime: { transport: 'builtin' },
    configuration: [
      {
        key: 'connectionMode',
        label: '连接模式',
        kind: 'select',
        required: true,
        default: 'websocket',
        options: [
          { value: 'websocket', label: '长连接' },
          { value: 'webhook', label: '回调' },
        ],
      },
      {
        key: 'verificationToken',
        label: 'Verification Token',
        kind: 'secret',
        required: true,
        requiredWhen: { key: 'connectionMode', value: 'webhook' },
      },
      { key: 'appId', label: 'App ID', kind: 'string', required: true },
    ],
    configurationVariants: {
      discriminator: 'connectionMode',
      branches: [
        {
          id: 'webhook',
          when: { properties: { connectionMode: { const: 'webhook' } } },
          fields: ['verificationToken'],
        },
        { id: 'websocket', when: { properties: { connectionMode: { const: 'websocket' } } }, fields: [] },
      ],
    },
    ...overrides,
  };
}

/** A configuration port over plain maps that records which keys were read. */
function port(store = {}) {
  const reads = { config: [], secret: [] };
  return {
    reads,
    configuration: {
      readConfig: async (_id, key) => {
        reads.config.push(key);
        return store.config?.[key];
      },
      readSecret: async (_id, key) => {
        reads.secret.push(key);
        return store.secrets?.[key];
      },
    },
  };
}

function projectionInput(store, manifest = feishuManifest()) {
  const tracked = port(store);
  return {
    reads: tracked.reads,
    input: {
      pluginInstanceId: INSTANCE_ID,
      manifest,
      effectiveGrants: GRANTS,
      configuration: tracked.configuration,
    },
  };
}

describe('§3.3 startup projection — resolveManifestConfiguration', () => {
  test('websocket mode without a Token resolves the active fields only', async () => {
    const { reads, input } = projectionInput({ config: { connectionMode: 'websocket', appId: 'cli_1' } });
    const resolved = await resolveManifestConfiguration(input);
    assert.deepEqual(resolved, [
      { key: 'connectionMode', kind: 'select', value: 'websocket' },
      { key: 'appId', kind: 'string', value: 'cli_1' },
    ]);
    assert.equal(reads.secret.includes('verificationToken'), false);
  });

  test('no stored discriminator falls back to the declared select default (websocket)', async () => {
    const resolved = await resolveManifestConfiguration(projectionInput({ config: { appId: 'cli_1' } }).input);
    assert.deepEqual(
      resolved.map((field) => [field.key, field.value]),
      [
        ['connectionMode', 'websocket'],
        ['appId', 'cli_1'],
      ],
    );
  });

  test('webhook mode delivers the Token; websocket-mode branch stays absent', async () => {
    const resolved = await resolveManifestConfiguration(
      projectionInput({
        config: { connectionMode: 'webhook', appId: 'cli_1' },
        secrets: { verificationToken: 'tok_feishu' },
      }).input,
    );
    assert.deepEqual(resolved, [
      { key: 'connectionMode', kind: 'select', value: 'webhook' },
      { key: 'verificationToken', kind: 'secret', value: 'tok_feishu' },
      { key: 'appId', kind: 'string', value: 'cli_1' },
    ]);
  });

  test('webhook mode without the required Token refuses to start', async () => {
    await assert.rejects(
      resolveManifestConfiguration(projectionInput({ config: { connectionMode: 'webhook', appId: 'cli_1' } }).input),
      (error) => error instanceof ManifestConfigurationProjectionError && error.failure.reason === 'value_unavailable',
    );
  });

  test('a discriminator value matching no branch fails closed as variant_invalid', async () => {
    await assert.rejects(
      resolveManifestConfiguration(projectionInput({ config: { connectionMode: 'bogus', appId: 'cli_1' } }).input),
      (error) =>
        error instanceof ManifestConfigurationProjectionError &&
        error.failure.reason === 'variant_invalid' &&
        error.failure.value === 'bogus',
    );
  });

  test('no stored value and no declared default fails closed as variant_unselected', async () => {
    const manifest = feishuManifest({
      configuration: feishuManifest().configuration.map((field) =>
        field.key === 'connectionMode' ? { ...field, default: undefined } : field,
      ),
    });
    await assert.rejects(
      resolveManifestConfiguration(projectionInput({ config: { appId: 'cli_1' } }, manifest).input),
      (error) => error instanceof ManifestConfigurationProjectionError && error.failure.reason === 'variant_unselected',
    );
  });
});

describe('§3.3 module settings — runtime vs management layering', () => {
  const current = async () => {};

  function settingsInput(store, t) {
    const dataRoot = mkdtempSync(join(tmpdir(), 'feishu-variants-settings-'));
    t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
    return {
      pluginInstanceId: INSTANCE_ID,
      packageRecord: { pluginId: PLUGIN_ID, manifest: feishuManifest() },
      effectiveGrants: GRANTS,
      options: { ...port(store), log: () => {}, dataDirectoryParent: dataRoot },
    };
  }

  test('runtime mode: websocket hides the inactive-branch Token without reading the store', async (t) => {
    const input = settingsInput({ config: { connectionMode: 'websocket', appId: 'cli_1' } }, t);
    const host = await createModuleSettingsHost(input, { ...input.options, variantMode: 'runtime' }, current);
    assert.equal(await host.secrets.get('verificationToken'), undefined);
    assert.equal(input.options.reads.secret.includes('verificationToken'), false);
    assert.equal(await host.config.get('appId'), 'cli_1');
  });

  test('runtime mode: webhook delivers the Token to the actual getter', async (t) => {
    const input = settingsInput(
      { config: { connectionMode: 'webhook', appId: 'cli_1' }, secrets: { verificationToken: 'tok_x' } },
      t,
    );
    const host = await createModuleSettingsHost(input, { ...input.options, variantMode: 'runtime' }, current);
    assert.equal(await host.secrets.get('verificationToken'), 'tok_x');
  });

  test('runtime mode: an invalid discriminator refuses every read (DELIVERY_REJECTED)', async (t) => {
    const input = settingsInput({ config: { connectionMode: 'bogus', appId: 'cli_1' } }, t);
    const host = await createModuleSettingsHost(input, { ...input.options, variantMode: 'runtime' }, current);
    await assert.rejects(host.config.get('appId'), (error) => error?.code === 'DELIVERY_REJECTED');
    await assert.rejects(host.secrets.get('verificationToken'), (error) => error?.code === 'DELIVERY_REJECTED');
  });

  test('management mode: legacy pass-through keeps every field reachable', async (t) => {
    const input = settingsInput({ config: { connectionMode: 'bogus', appId: 'cli_1' } }, t);
    const host = await createModuleSettingsHost(input, input.options, current);
    assert.equal(await host.config.get('appId'), 'cli_1');
  });
});

describe('§3.1/§3.2 console projection and save readiness', () => {
  function serviceWith(manifest, projectRoot) {
    const store = new MemoryPluginInventoryStore({
      schemaVersion: 1,
      packages: [
        {
          packageDigest:
            'sha512-nS30Id366PuoMLzqvOmFpVEhOpKJajb9sYErfLqhheirEnid5KMDe07Xx3Lk/EuBkaIgh0Rbcyst4k++1zF2rg==',
          pluginId: PLUGIN_ID,
          version: '1.0.0',
          contractVersion: '0.2.0',
          manifest,
          signalSchemas: {},
          packageState: 'installed',
          verifiedAt: 1,
          updatedAt: 1,
        },
      ],
      instances: [
        {
          pluginInstanceId: INSTANCE_ID,
          pluginId: PLUGIN_ID,
          packageDigest:
            'sha512-nS30Id366PuoMLzqvOmFpVEhOpKJajb9sYErfLqhheirEnid5KMDe07Xx3Lk/EuBkaIgh0Rbcyst4k++1zF2rg==',
          lifecycleState: 'installed',
          configReadiness: 'incomplete',
          activationState: 'disabled',
          runtimeState: 'stopped',
          lifecycleRevision: 1,
          installedAt: 1,
          updatedAt: 1,
        },
      ],
      grants: [
        {
          pluginInstanceId: INSTANCE_ID,
          requestedCapabilities: GRANTS,
          effectiveGrants: GRANTS,
          grantRevision: 1,
          updatedAt: 1,
        },
      ],
    });
    return { store, service: new HostPluginConfigurationService({ projectRoot, inventory: store }) };
  }

  test('URL readiness validates persisted nonempty values with the contract URI schema', async (t) => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'variants-uri-readiness-'));
    t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
    const base = feishuManifest();
    const manifest = {
      ...base,
      configuration: [
        ...base.configuration,
        { key: 'callbackUrl', label: 'Callback URL', kind: 'url', required: true },
      ],
    };
    const { store, service } = serviceWith(manifest, projectRoot);
    for (const [value, readiness] of [
      ['https://example.org/callback?mode=webhook', 'ready'],
      ['not a URL', 'incomplete'],
      ['/relative/callback', 'incomplete'],
      ['', 'incomplete'],
      ['http://example.org/callback', 'ready'],
    ]) {
      // Reconcile persisted configuration, including values saved before this
      // contract version; the configure request's URL validator cannot mask it.
      writePluginConfig(projectRoot, PLUGIN_ID, [
        { name: 'appId', value: 'cli_1' },
        { name: 'callbackUrl', value },
      ]);
      await service.reconcile(PLUGIN_ID, INSTANCE_ID);
      assert.equal((await store.snapshot()).instances[0].configReadiness, readiness, value);
    }
  });

  test('required operation readiness comes from scalar targets without a stored operation value', async (t) => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'variants-operation-readiness-'));
    t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
    const base = feishuManifest();
    const manifest = {
      ...base,
      configuration: [
        ...base.configuration,
        { key: 'callbackUrl', label: 'Callback URL', kind: 'url', required: true },
        {
          key: 'connect',
          label: 'Connect',
          kind: 'operation',
          required: true,
          target: ['appId', 'callbackUrl'],
          actions: [{ id: 'start', label: 'Start', render: 'button', action: { method: 'connect.start' } }],
        },
      ],
    };
    const { store, service } = serviceWith(manifest, projectRoot);
    assert.equal((await service.fields(PLUGIN_ID)).find((field) => field.key === 'connect').configured, false);
    await service.configureOperationTargets(PLUGIN_ID, INSTANCE_ID, 'connect', {
      appId: 'cli_1',
      callbackUrl: 'https://example.org/callback',
    });
    await service.reconcile(PLUGIN_ID, INSTANCE_ID);
    assert.equal((await service.fields(PLUGIN_ID)).find((field) => field.key === 'connect').configured, true);
    assert.equal((await store.snapshot()).instances[0].configReadiness, 'ready');
    assert.equal(Object.hasOwn(readPluginConfig(projectRoot, PLUGIN_ID), 'connect'), false);
  });

  for (const [kind, key] of [
    ['string', 'appId'],
    ['secret', 'verificationToken'],
  ]) {
    test(`whitespace-only ${kind} keeps variant readiness incomplete without rewriting stored values`, async (t) => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'variants-whitespace-readiness-'));
      t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
      const { store, service } = serviceWith(feishuManifest(), projectRoot);
      const values = { connectionMode: 'webhook', appId: 'cli_1', verificationToken: 'fixture-token', [key]: ' \t\n' };
      await service.configure(PLUGIN_ID, INSTANCE_ID, {
        expectedRevision: 1,
        updates: Object.entries(values).map(([key, value]) => ({ key, value })),
      });
      assert.equal(readPluginConfig(projectRoot, PLUGIN_ID)[key], values[key]);
      assert.equal((await store.snapshot()).instances[0].configReadiness, 'incomplete');
    });
  }

  test('a secret containing non-whitespace characters stays byte-identical in storage and startup projection', async (t) => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'variants-secret-preservation-'));
    t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
    const { store, service } = serviceWith(feishuManifest(), projectRoot);
    const secret = ' \tfixture-token \n';
    await service.configure(PLUGIN_ID, INSTANCE_ID, {
      expectedRevision: 1,
      updates: [
        { key: 'connectionMode', value: 'webhook' },
        { key: 'appId', value: 'cli_1' },
        { key: 'verificationToken', value: secret },
      ],
    });
    const stored = readPluginConfig(projectRoot, PLUGIN_ID);
    assert.equal(stored.verificationToken, secret);
    assert.equal((await store.snapshot()).instances[0].configReadiness, 'ready');
    const projected = await resolveManifestConfiguration(projectionInput({ config: stored, secrets: stored }).input);
    assert.equal(projected.find((field) => field.key === 'verificationToken').value, secret);
  });

  test('fields() projects the variant declaration onto every field', async (t) => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'feishu-variants-fields-'));
    t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
    const { service } = serviceWith(feishuManifest(), projectRoot);
    const fields = await service.fields(PLUGIN_ID);
    const variants = fields.find((field) => field.key === 'appId')?.configurationVariants;
    assert.equal(variants?.discriminator, 'connectionMode');
    assert.equal(variants?.branches.length, 2);
    for (const field of fields) assert.deepEqual(field.configurationVariants, variants);
  });

  test('readiness: webhook without Token stays incomplete; with Token turns ready; websocket needs no Token', async (t) => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'feishu-variants-ready-'));
    t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
    const { store, service } = serviceWith(feishuManifest(), projectRoot);
    const configure = (updates, expectedRevision) =>
      service.configure(PLUGIN_ID, INSTANCE_ID, { expectedRevision, updates });

    await configure(
      [
        { key: 'connectionMode', value: 'webhook' },
        { key: 'appId', value: 'cli_1' },
      ],
      1,
    );
    let instance = (await store.snapshot()).instances[0];
    assert.equal(instance.configReadiness, 'incomplete');

    await configure([{ key: 'verificationToken', value: 'tok_x' }], 2);
    instance = (await store.snapshot()).instances[0];
    assert.equal(instance.configReadiness, 'ready');

    await configure(
      [
        { key: 'connectionMode', value: 'websocket' },
        { key: 'verificationToken', value: null },
      ],
      3,
    );
    instance = (await store.snapshot()).instances[0];
    assert.equal(instance.configReadiness, 'ready');
  });
});
