import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const apiPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const rootPackage = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
const eventMapperSource = await readFile(
  new URL('../src/domains/cats/services/agents/providers/CodexAppServerEventMapper.ts', import.meta.url),
  'utf8',
);
const { boundedUnsupportedCodexAppServerNotificationMethod, mapCodexAppServerNotification } = await import(
  '../src/domains/cats/services/agents/providers/CodexAppServerEventMapper.ts'
);

test('ordinary root and API builds never execute an ambient Codex protocol audit', () => {
  assert.doesNotMatch(rootPackage.scripts.build, /codex|protocol[ -]?audit|protocol[ -]?census/i);
  assert.doesNotMatch(apiPackage.scripts.build, /codex|protocol[ -]?audit|protocol[ -]?census/i);
});

test('Codex protocol inspection is an explicit audit command outside ordinary build', () => {
  assert.match(apiPackage.scripts['audit:codex-protocol'] ?? '', /audit-codex-app-server-protocol\.mjs/);
  assert.doesNotMatch(apiPackage.scripts.build, /audit:codex-protocol/);
  assert.match(apiPackage.scripts['verify:codex-build-independence'] ?? '', /verify-codex-build-independence\.mjs/);
});

test('explicit protocol audit reports a live snapshot without a pinned comparison fixture', async () => {
  const { computeProtocolSnapshot } = await import('../scripts/audit-codex-app-server-protocol.mjs');
  const snapshot = computeProtocolSnapshot({
    codexVersion: 'codex-cli 9.8.7',
    stable: {
      clientRequests: ['thread/start'],
      serverNotifications: ['turn/completed'],
      serverRequests: ['item/fileChange/requestApproval'],
      schemaFingerprint: 'stable-a',
      deprecations: [{ path: 'stable/Old.json', message: 'Old field is deprecated' }],
    },
    experimental: {
      clientRequests: ['thread/start', 'future/start'],
      serverNotifications: ['turn/completed'],
      serverRequests: ['item/fileChange/requestApproval', 'future/request'],
      schemaFingerprint: 'experimental-a',
      deprecations: [],
    },
    threadItemTypes: ['fileChange', 'futureTool'],
  });

  assert.equal(snapshot.codexVersion, '9.8.7');
  assert.deepEqual(snapshot.stable.counts, {
    clientRequests: 1,
    serverNotifications: 1,
    serverRequests: 1,
  });
  assert.deepEqual(snapshot.experimental.methodDelta, {
    clientRequests: ['future/start'],
    serverNotifications: [],
    serverRequests: ['future/request'],
  });
  assert.deepEqual(snapshot.threadItemTypes, ['fileChange', 'futureTool']);
  assert.equal(snapshot.stable.schemaFingerprint, 'stable-a');
  assert.deepEqual(snapshot.stable.deprecations, [{ path: 'stable/Old.json', message: 'Old field is deprecated' }]);
});

test('protocol audit compares exact versions, schemas, methods, items, and deprecations', async () => {
  const { compareProtocolSnapshots } = await import('../scripts/audit-codex-app-server-protocol.mjs');
  const previous = {
    codexVersion: '0.148.0',
    stable: {
      counts: { clientRequests: 1, serverNotifications: 1, serverRequests: 1 },
      methods: {
        clientRequests: ['thread/start'],
        serverNotifications: ['turn/completed'],
        serverRequests: ['approval/old'],
      },
      schemaFingerprint: 'stable-old',
      deprecations: [{ path: 'Old.json', message: 'old deprecated' }],
    },
    experimental: {
      counts: { clientRequests: 1, serverNotifications: 1, serverRequests: 1 },
      methods: {
        clientRequests: ['thread/start'],
        serverNotifications: ['turn/completed'],
        serverRequests: ['approval/old'],
      },
      methodDelta: { clientRequests: [], serverNotifications: [], serverRequests: [] },
      schemaFingerprint: 'experimental-old',
      deprecations: [],
    },
    threadItemTypes: ['message', 'oldItem'],
  };
  const current = {
    codexVersion: '0.149.1',
    stable: {
      counts: { clientRequests: 2, serverNotifications: 1, serverRequests: 1 },
      methods: {
        clientRequests: ['app/list', 'thread/start'],
        serverNotifications: ['turn/completed'],
        serverRequests: ['approval/new'],
      },
      schemaFingerprint: 'stable-new',
      deprecations: [{ path: 'New.json', message: 'new deprecated' }],
    },
    experimental: {
      counts: { clientRequests: 2, serverNotifications: 1, serverRequests: 1 },
      methods: {
        clientRequests: ['app/list', 'thread/start'],
        serverNotifications: ['turn/completed'],
        serverRequests: ['approval/new'],
      },
      methodDelta: { clientRequests: [], serverNotifications: [], serverRequests: [] },
      schemaFingerprint: 'experimental-new',
      deprecations: [],
    },
    threadItemTypes: ['message', 'newItem'],
  };

  const delta = compareProtocolSnapshots(previous, current);
  assert.equal(delta.fromVersion, '0.148.0');
  assert.equal(delta.toVersion, '0.149.1');
  assert.equal(delta.stable.schemaChanged, true);
  assert.deepEqual(delta.stable.methods.clientRequests.added, ['app/list']);
  assert.deepEqual(delta.stable.methods.serverRequests.removed, ['approval/old']);
  assert.deepEqual(delta.stable.deprecations.added, [{ path: 'New.json', message: 'new deprecated' }]);
  assert.deepEqual(delta.threadItemTypes, { added: ['newItem'], removed: ['oldItem'] });
});

test('protocol comparison rejects malformed operator snapshots', async () => {
  const { compareProtocolSnapshots } = await import('../scripts/audit-codex-app-server-protocol.mjs');
  const validLayer = {
    clientRequests: [],
    serverNotifications: [],
    serverRequests: [],
    schemaFingerprint: 'a'.repeat(64),
    deprecations: [],
  };
  const valid = {
    codexVersion: '0.153.3',
    stable: validLayer,
    experimental: { ...validLayer, schemaFingerprint: 'b'.repeat(64) },
    threadItemTypes: [],
  };
  const oversizedMethods = new Proxy(
    Array.from({ length: 2_001 }, () => 'thread/start'),
    {
      get(target, property, receiver) {
        if (property === '0') throw new Error('oversized method arrays must be rejected before entry reads');
        return Reflect.get(target, property, receiver);
      },
    },
  );

  for (const [label, malformed, expected] of [
    ['version', { ...valid, codexVersion: 'not-a-version' }, /Unrecognized Codex CLI version/],
    ['stable layer', { ...valid, stable: undefined }, /stable layer is missing/],
    [
      'method list',
      { ...valid, stable: { ...valid.stable, clientRequests: 'not-an-array' } },
      /stable\.clientRequests must be an array of strings/,
    ],
    [
      'method cardinality',
      { ...valid, stable: { ...valid.stable, clientRequests: oversizedMethods } },
      /stable\.clientRequests exceeds its bounded string-list contract/,
    ],
    [
      'fingerprint',
      { ...valid, experimental: { ...valid.experimental, schemaFingerprint: '' } },
      /experimental\.schemaFingerprint/,
    ],
    [
      'deprecations',
      { ...valid, stable: { ...valid.stable, deprecations: [{ path: 'OnlyPath' }] } },
      /stable\.deprecations.*path and message/,
    ],
  ]) {
    assert.throws(() => compareProtocolSnapshots(malformed, valid), expected, label);
  }
});

test('audit CLI exits nonzero before provider collection for an incomplete comparison snapshot', () => {
  const auditScript = fileURLToPath(new URL('../scripts/audit-codex-app-server-protocol.mjs', import.meta.url));
  const result = spawnSync(
    process.execPath,
    [auditScript, '--against', JSON.stringify({ codexVersion: '0.149.1', threadItemTypes: [] })],
    { encoding: 'utf8' },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stable layer is missing/);
});

test('the permanent full-protocol fixture and build-blocking census script are removed', async () => {
  await assert.rejects(
    access(new URL('./fixtures/codex-app-server-thread-item-types.json', import.meta.url)),
    /ENOENT/,
  );
  await assert.rejects(
    access(new URL('../scripts/check-codex-app-server-protocol-census.mjs', import.meta.url)),
    /ENOENT/,
  );
});

test('the unsupported-notification filter derives mapped methods instead of mirroring them by hand', () => {
  assert.doesNotMatch(eventMapperSource, /CONSUMED_NOTIFICATION_METHODS/);
  assert.match(eventMapperSource, /Object\.hasOwn\(CODEX_APP_SERVER_NOTIFICATION_MAPPERS, method\)/);

  for (const method of [
    'item/started',
    'item/completed',
    'turn/started',
    'turn/plan/updated',
    'turn/completed',
    'error',
    'thread/tokenUsage/updated',
  ]) {
    assert.equal(boundedUnsupportedCodexAppServerNotificationMethod({ method }), null, method);
  }
  assert.equal(boundedUnsupportedCodexAppServerNotificationMethod({ method: 'turn/interrupted' }), 'turn/interrupted');

  for (const method of ['valueOf', 'hasOwnProperty', 'toString', 'constructor', '__proto__']) {
    assert.equal(mapCodexAppServerNotification({ method, params: {} }), null, method);
    assert.equal(boundedUnsupportedCodexAppServerNotificationMethod({ method }), method, method);
  }
});
