import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { test } from 'node:test';

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
    },
    experimental: {
      clientRequests: ['thread/start', 'future/start'],
      serverNotifications: ['turn/completed'],
      serverRequests: ['item/fileChange/requestApproval', 'future/request'],
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
