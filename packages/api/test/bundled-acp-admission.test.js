import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bundledAcpFixture, clients } from './helpers/bundled-acp-fixture.js';

for (const client of clients) {
  test(`${client.id}: real bundled catalog installs, enables and unregisters its declaration`, async (t) => {
    const f = await bundledAcpFixture(t);
    const entry = await f.bundle(client);
    const result = await f.run(entry);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.initialIntent, 'disabled');
    assert.equal(result.registered, true);
    assert.equal(result.unregistered, true);
    assert.equal(result.snapshot.packages[0].manifest.runtime, undefined);
    assert.equal(result.snapshot.packages[0].provenance.kind, 'catalog');
    assert.equal(result.library.configurationKey, null, 'a fixed connection must not select the multi-client editor');
    assert.deepEqual(result.library.clients, [
      { id: client.id, name: client.id, ref: `plugin:${client.pluginId}/${client.id}`, available: true },
    ]);
    const local = await f.run(entry, 'local');
    assert.equal(local.status, 201, JSON.stringify(local.body));
    assert.equal(local.registered, true);
    assert.equal(local.snapshot.packages[0].packageDigest, result.snapshot.packages[0].packageDigest);
    assert.equal(local.snapshot.packages[0].provenance.kind, 'local-archive');
    const executed = await f.run(entry, 'execute');
    assert.equal(executed.status, 201, JSON.stringify(executed.body));
    assert.equal(executed.turns.length, 3);
    assert.equal(executed.reenabled, true);
    assert.ok(
      executed.turns.every((text) => text.includes('permission=reject')),
      JSON.stringify(executed.turns),
    );
    assert.equal(
      executed.turns[0].split(':')[1],
      executed.turns[1].split(':')[1],
      'one member continues its native session',
    );
    assert.notEqual(
      executed.turns[0].split(':')[1],
      executed.turns[2].split(':')[1],
      'members do not share native sessions',
    );
  });

  test(`${client.id}: failed download admission can retry without deleting inventory`, async (t) => {
    const f = await bundledAcpFixture(t);
    const result = await f.run(await f.bundle(client), 'retry');
    assert.equal(result.failed.body.code, 'PACKAGE_DOWNLOAD_FAILED');
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.snapshot.instances.length, 1);
  });

  test(`${client.id}: rejected update and later successful update retain configuration, binding and history`, async (t) => {
    const f = await bundledAcpFixture(t);
    const seed = await f.run(await f.bundle(client), 'seed');
    assert.equal(seed.status, 201, JSON.stringify(seed.body));
    const bad = await f.run(await f.bundle(client, { version: '2.0.0', omitDeclaration: true }), 'update-bad');
    assert.equal(bad.body.code, 'UNSUPPORTED_TRANSPORT');
    assert.equal(bad.configRetained, true);
    const good = await f.run(await f.bundle(client, { version: '2.0.1' }), 'update');
    assert.equal(good.status, 200, JSON.stringify(good.body));
    assert.equal(good.sameInstance, true);
    assert.equal(good.instanceId, seed.instanceId);
    assert.equal(good.configRetained, true);
    assert.match(good.history, /KEEP HISTORY/);
    assert.equal(good.binding.tool, `plugin:${client.pluginId}/${client.id}`);
    assert.equal(good.registered, true);
  });
}

test('corrupt bundled bytes retain quarantine instead of bypassing it on retry', async (t) => {
  const f = await bundledAcpFixture(t);
  const result = await f.run(await f.bundle(clients[0]), 'quarantine');
  assert.equal(result.failed.body.code, 'PACKAGE_DIGEST_MISMATCH');
  assert.equal(result.body.code, 'ACTION_NOT_ALLOWED');
  assert.equal(result.snapshot.instances.length, 0);
});

test('bundled is not a blanket exemption for missing or executable runtimes', async (t) => {
  const f = await bundledAcpFixture(t);
  for (const options of [
    { omitDeclaration: true },
    { declaration: '{bad json' },
    { declaration: ' '.repeat(65537) },
    { declaration: { id: 'codeagent', transport: 'http', acp: { command: 'codeagent', startupArgs: [] } } },
    { declaration: { id: 'codeagent', transport: 'acp', acp: { command: './entrypoint.js', startupArgs: [] } } },
    { runtime: { transport: 'stdio', entrypoint: 'dist/entrypoint.js' } },
  ]) {
    const result = await f.run(await f.bundle(clients[0], options));
    assert.equal(result.status, 422);
    assert.equal(result.body.code, 'UNSUPPORTED_TRANSPORT');
    assert.equal(result.snapshot.instances.length, 0);
  }
});

test('a differently named ACP client uses the same bundled admission', async (t) => {
  const f = await bundledAcpFixture(t);
  const client = { ...clients[0], id: 'generic-agent', pluginId: 'example.generic-agent' };
  assert.equal((await f.run(await f.bundle(client))).status, 201);
});
