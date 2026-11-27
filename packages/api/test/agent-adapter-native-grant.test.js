import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { writeCatalogAccount } from '../dist/config/catalog-accounts.js';
import { resolveKimiQuotaExecutionOwner } from '../dist/config/kimi-quota-identity.js';
import { grantAgentAdapterNativeRuntime } from '../dist/domains/plugin/declared/agent-adapter-native-grant.js';

test('default detection grants only inspect for a matching catalog identity', () => {
  const source = {
    kind: 'catalog',
    catalogId: 'agent-kimi',
    packageName: '@clowder-ai/agent-kimi',
  };
  const request = {
    pluginId: 'official.agent-kimi',
    contributionId: 'kimi',
    pluginInstanceId: 'pi_kimi',
    packageDigest: 'verified-host-inventory-digest',
    packageProvenance: source,
    action: 'detect',
  };
  assert.deepEqual(Object.keys(grantAgentAdapterNativeRuntime(request) ?? {}), ['inspect']);
  for (const mismatch of [
    { pluginId: 'local.agent-kimi' },
    { contributionId: 'codex' },
    { packageProvenance: { ...source, catalogId: 'other' } },
    { packageProvenance: { ...source, packageName: '@other/agent-kimi' } },
    { packageProvenance: { kind: 'local-archive', packageName: source.packageName } },
    { packageProvenance: { kind: 'git', url: 'https://example.invalid/agent', packageName: source.packageName } },
    { packageProvenance: undefined },
    { action: 'quota' },
    { action: 'openSession' },
  ]) {
    assert.equal(grantAgentAdapterNativeRuntime({ ...request, ...mismatch }), undefined);
  }
});

test('quota authorization requires the selected account generation and fixed terminal input', async (t) => {
  const request = {
    pluginId: 'official.agent-kimi',
    contributionId: 'kimi',
    pluginInstanceId: 'pi_kimi',
    packageDigest: 'verified-host-inventory-digest',
    packageProvenance: {
      kind: 'catalog',
      catalogId: 'agent-kimi',
      packageName: '@clowder-ai/agent-kimi',
    },
    action: 'quota',
  };
  assert.equal(grantAgentAdapterNativeRuntime(request), undefined);
  const parent = resolve(tmpdir());
  const projectRoot = await mkdtemp(join(parent, 'agent-quota-grant-'));
  const oldRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectRoot;
  t.after(async () => {
    if (oldRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = oldRoot;
    assert.equal(dirname(projectRoot), parent);
    await rm(projectRoot, { recursive: true, force: true });
  });
  const accountHome = join(projectRoot, 'isolated-account');
  const credential = join(accountHome, 'credentials', 'fixture.json');
  await mkdir(dirname(credential), { recursive: true });
  await writeFile(
    join(accountHome, 'config.toml'),
    '[providers.fixture]\ntype = "kimi"\n[providers.fixture.oauth]\nstorage = "file"\nkey = "fixture"\n',
  );
  await writeFile(credential, '{"access_token":"fake-initial"}');
  writeCatalogAccount(projectRoot, 'fixture-kimi', {
    authType: 'oauth',
    clientId: 'kimi',
    envVars: { KIMI_CODE_HOME: accountHome },
  });
  const owner = resolveKimiQuotaExecutionOwner(projectRoot, 'fixture-kimi');
  assert.ok(owner?.snapshot.credentialVersion);
  const account = {
    projectRoot,
    accountRef: owner.snapshot.accountRef,
    credentialVersion: owner.snapshot.credentialVersion,
    accountRevision: owner.snapshot.accountRevision,
  };
  assert.equal(
    grantAgentAdapterNativeRuntime({ ...request, account, packageProvenance: { kind: 'local-archive' } }),
    undefined,
  );
  const grant = grantAgentAdapterNativeRuntime({ ...request, account });
  assert.deepEqual(Object.keys(grant ?? {}), ['terminal']);
  await assert.rejects(
    grant.terminal.capture({ submit: '/login' }, new AbortController().signal),
    /Terminal input is not authorized/,
  );
  await assert.rejects(
    grant.terminal.capture({ submit: '/usage' }, AbortSignal.abort(new Error('fixture cancellation'))),
    /fixture cancellation/,
  );
  await writeFile(credential, '{"access_token":"fake-rotated"}');
  await assert.rejects(
    grant.terminal.capture({ submit: '/usage' }, new AbortController().signal),
    /kimi_quota_credential_changed/,
  );
});
