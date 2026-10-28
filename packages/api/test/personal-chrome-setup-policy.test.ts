import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PluginPackageRecord } from '../src/domains/plugin/host-inventory/types.js';
import { chromeSetupPolicy } from '../src/domains/plugin/manager/chrome-setup/personal-chrome-setup-policy.js';

// Immutable published alpha.6 bytes, independently checked against npm dist.integrity.
const version = '0.1.0-alpha.6';
const digest = 'sha512-ypOOdp+jONUH1H9W9qbOLLZVyZ8gXZPs0w4aWuHpTbwhdn1PUIrK4f/DsKwmNyHcrGyq4oF1izrgjC8z8NhN4A==';
function record(): PluginPackageRecord & { manifest: NonNullable<PluginPackageRecord['manifest']> } {
  return {
    pluginId: 'official.companion.personal-chrome',
    version,
    packageDigest: digest,
    contractVersion: '0.1.0',
    packageState: 'installed',
    signalSchemas: {},
    verifiedAt: 1,
    updatedAt: 1,
    manifest: {
      pluginId: 'official.companion.personal-chrome',
      version,
      name: 'Personal Chrome',
      contractVersion: '0.1.0',
      runtime: { transport: 'builtin', entrypoint: 'dist/plugin-entrypoint.js' },
      features: [{ id: 'main', name: 'Main', resources: [], capabilities: [] }],
    },
  };
}

test('published catalog alpha.6 receives the same fixed Host setup actions', () => {
  assert.deepEqual(
    chromeSetupPolicy(record())?.actions.map(({ id }) => id),
    ['inspect', 'install', 'uninstall'],
  );
});

test('catalog identity and version never grant arbitrary bytes HOME setup authority', () => {
  for (const delta of [
    { packageDigest: 'sha512-unreviewed' },
    { version: '0.1.0-alpha.7' },
    { pluginId: 'dev.foreign.chrome' },
    { packageState: 'quarantined' as const },
    { manifest: { ...record().manifest, version: '0.1.0-alpha.4' } },
  ])
    assert.equal(chromeSetupPolicy({ ...record(), ...delta }), undefined);
});

const alpha7 = {
  version: '0.1.0-alpha.7',
  digest: 'sha512-/lLrNrAsCYEhwHiJuaaiEnG8YIzKGJ+tIX2C8FGFF2BJQd8Rtz6/dg4pXpeVDhUFt16c+7oRitfEnWCGU+Tr+g==',
};
function alpha7Record() {
  const candidate = record();
  candidate.version = alpha7.version;
  candidate.packageDigest = alpha7.digest;
  candidate.manifest.version = alpha7.version;
  return candidate;
}

test('the exact reviewed alpha.7 archive receives Host Chrome setup actions', () => {
  assert.deepEqual(
    chromeSetupPolicy(alpha7Record())?.actions.map(({ id }) => id),
    ['inspect', 'install', 'uninstall'],
  );
});

test('alpha.7 with the right version but unreviewed bytes remains untrusted', () => {
  assert.equal(chromeSetupPolicy({ ...alpha7Record(), packageDigest: 'sha512-unreviewed-alpha7' }), undefined);
});

test('the exact alpha.8 health fix receives setup actions while other alpha.8 bytes remain untrusted', () => {
  const candidate = record();
  candidate.version = '0.1.0-alpha.8';
  candidate.manifest.version = candidate.version;
  candidate.packageDigest =
    'sha512-ePdPiPWIyzscHHi9IDi0WGAZK4a9nvDgW6eGkzHA+4gMRqxusmmqMQf8f+ktoGjGFcHUgG4eeJVTlpwm2bj8lg==';
  assert.deepEqual(
    chromeSetupPolicy(candidate)?.actions.map(({ id }) => id),
    ['inspect', 'install', 'uninstall'],
  );
  assert.equal(chromeSetupPolicy({ ...candidate, packageDigest: 'sha512-unreviewed-alpha8' }), undefined);
});
