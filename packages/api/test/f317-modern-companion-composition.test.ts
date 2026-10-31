import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONCIERGE_CONFIG_DEFAULTS } from '@cat-cafe/shared';
import { COMPANION_ARCHIVE_CONTRACTS } from '../src/domains/plugin/desktop-window-runtime/published-companion-v2.js';
import { modernCompanionInstallFixture as fixture } from './helpers/f317-companion-install-fixture.js';

test('subtitle-return archive keeps beta.24 through installation and loads its verified return control', async (t) => {
  const f = await fixture(t, '0.1.0-alpha.19');
  const request = f.launch.request;
  assert.ok(request);
  assert.equal((await request({ kind: 'settings.read' })).kind, 'settings');
  const decisions = await request({ kind: 'decisions.read', offset: 0, limit: 20 });
  assert.ok('version' in decisions && decisions.version === 1);
  assert.equal(decisions.status, 'available');
  assert.equal(f.closes(), 0, 'reading and loading do not end the window');
  if (f.actualArchive) {
    const response = await fetch(f.launch.url);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /id="transcript-return"[^>]*data-action="transcript-return"/);
    assert.match(html, /返回通话/);
    const snapshot = await f.runtime.inventoryStore.snapshot();
    const pkg = snapshot.packages.find(
      (row) => row.pluginId === 'official.companion' && row.version === '0.1.0-alpha.19',
    );
    const archive = COMPANION_ARCHIVE_CONTRACTS.find((row) => row.version === '0.1.0-alpha.19');
    assert.ok(pkg);
    assert.ok(archive);
    assert.equal(pkg.packageDigest, archive.packageDigest);
  }
});

test('the exact unified archive preserves the landed F310 full/partial truth through one selected ABI', async (t) => {
  const f = await fixture(t, '0.1.0-alpha.15');
  const command = { kind: 'decisions.read', offset: 0, limit: 20 };
  const full = await f.launch.request!(command);
  assert.ok('version' in full && 'items' in full);
  assert.equal(full.version, 1);
  assert.equal(full.status, 'available');
  assert.equal(full.totalCount, 1);
  assert.deepEqual(full.items[0]!.navigation.targets, [], 'unanchored source does not grant a guessed destination');
  assert.equal(full.items[0]!.summary, 'Choose composition');
  for (const privateField of ['proposalId', 'sourceFeatureId', 'ownerUserId'])
    assert.equal(JSON.stringify(full).includes(privateField), false);
  f.failNeedsMe();
  const partial = await f.launch.request!(command);
  assert.ok('version' in partial && 'items' in partial);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.items.length, 1);
  assert.equal('totalCount' in partial, false);
  assert.equal((await f.launch.request!({ kind: 'settings.read' })).kind, 'settings');
});

test('modern archive selects one ABI through installation, Broker, Bridge and kernel; its disable receipt proves cleanup', async (t) => {
  const f = await fixture(t, '0.1.0-alpha.14');
  const request = f.launch.request!;
  assert.equal((await request({ kind: 'settings.read' })).kind, 'settings');
  assert.equal((await request({ kind: 'companion.disable', pluginInstanceId: 'another' })).kind, 'error');
  assert.equal((await f.runtime.desktopWindows?.presence()) !== null, true);
  assert.deepEqual(await request({ kind: 'companion.disable' }), {
    kind: 'companion-lifecycle',
    action: 'disable',
    outcome: 'disabled',
  });
  assert.equal(f.closes(), 1);
  assert.equal(await f.runtime.desktopWindows?.presence(), null);
  const state = await f.runtime.inventoryStore.snapshot();
  assert.equal(state.instances.find((row) => row.pluginInstanceId === f.instanceId)?.activationState, 'disabled');
  assert.ok(
    state.packages.some((row) => row.pluginId === 'official.companion'),
    'disable preserves the installed archive',
  );
  assert.equal((await f.messages.getById(f.saved.id))?.content, 'preserved');
  assert.deepEqual(f.config, { ...CONCIERGE_CONFIG_DEFAULTS, dutyCatProfileId: 'composition-selected' });
  assert.equal((await request({ kind: 'settings.read' })).kind, 'error', 'old authority cannot read after disable');
});

test('legacy alpha.13 selects beta.21 throughout and cannot submit modern settings or disable commands', async (t) => {
  const f = await fixture(t, '0.1.0-alpha.13');
  for (const command of [{ kind: 'settings.read' }, { kind: 'companion.disable' }])
    assert.deepEqual(await f.launch.request!(command), { kind: 'error', code: 'invalid_request' });
  assert.equal(f.closes(), 0);
  assert.ok(await f.runtime.desktopWindows?.presence());
});

test('modern disable never reports disabled if physical cleanup rejects', async (t) => {
  const f = await fixture(t, '0.1.0-alpha.14');
  f.denyClose();
  assert.equal((await f.launch.request!({ kind: 'companion.disable' })).kind, 'error');
  assert.equal(f.closes(), 1);
});

test('an old disable request cannot adopt the lifecycle revision of a replacement window', async (t) => {
  const f = await fixture(t, '0.1.0-alpha.14');
  const desktop = f.runtime.desktopWindows;
  assert.ok(desktop);
  const run = desktop.features.run.bind(desktop.features);
  let checks = 0;
  let replaced = false;
  t.mock.method(desktop.features, 'run', async (lease: string, work: Parameters<typeof run>[1]) => {
    const result = await run(lease, work);
    if (!replaced && ++checks === 2) {
      replaced = true;
      const current = (await f.runtime.inventoryStore.snapshot()).instances.find(
        (row) => row.pluginInstanceId === f.instanceId,
      );
      assert.ok(current);
      const stopped = await f.runtime.lifecycle.disable(f.instanceId, current.lifecycleRevision);
      await f.runtime.lifecycle.enable(f.instanceId, stopped.lifecycleRevision);
    }
    return result;
  });
  const stale = await f.launch.request!({ kind: 'companion.disable' });
  assert.equal(replaced, true, 'replacement occurs after the old lease check and before the lifecycle read');
  assert.equal(stale.kind, 'error');
  assert.ok(await desktop.presence(), 'the new window stays enabled');
  assert.equal(f.closes(), 1, 'only the external replacement closed the old body');
});

test('a rejected effect remains observed when its feature transaction fails after starting it', async (t) => {
  const f = await fixture(t, '0.1.0-alpha.14');
  const desktop = f.runtime.desktopWindows;
  assert.ok(desktop);
  const run = desktop.features.run.bind(desktop.features);
  let refusedCommit = false;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  t.mock.method(f.runtime.lifecycle, 'disable', async () => {
    throw new Error('cleanup failed');
  });
  t.mock.method(desktop.features, 'run', async (lease: string, work: Parameters<typeof run>[1]) => {
    const result = await run(lease, work);
    if (result && typeof result === 'object' && 'completion' in result) {
      refusedCommit = true;
      throw new Error('feature transaction commit failed');
    }
    return result;
  });
  assert.equal((await f.launch.request!({ kind: 'companion.disable' })).kind, 'error');
  assert.equal(refusedCommit, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, [], 'an effect rejection must not escape after admission reports a different failure');
});
