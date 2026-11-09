import assert from 'node:assert/strict';
import { readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { ContentEditorPluginRuntime } from '../src/domains/plugin/content-editor-runtime/runtime.js';
import { FilesystemVerifiedPluginPackageLocator } from '../src/domains/plugin/external-runtime/filesystem-package-locator.js';
import { HostBrokerControlPlane } from '../src/domains/plugin/host-broker/control-plane.js';
import { MemoryHostBrokerStore } from '../src/domains/plugin/host-broker/stores.js';
import { staticEditorFixture, staticEditorManifest } from './plugin-static-editor.fixture.js';

async function integrityFixture(t: TestContext, sealed = true, rejectStartup = false) {
  const f = await staticEditorFixture(staticEditorManifest());
  const id = (await f.install()).pluginInstanceId;
  await f.store.transaction(async (tx) => {
    const instance = await tx.instances.get(id);
    assert.ok(instance);
    await tx.instances.put({
      ...instance,
      activationState: 'enabled',
      configReadiness: 'ready',
      runtimeState: 'healthy',
      lifecycleRevision: 2,
    });
  });
  let now = 1_000;
  let fullReads = 0;
  let sealReads = 0;
  let fullDelay = 0;
  let root = '';
  const store = new MemoryHostBrokerStore();
  const broker = new HostBrokerControlPlane({ inventory: f.store, store, now: () => now });
  const locator = new FilesystemVerifiedPluginPackageLocator(join(f.root, 'cache'));
  const reports: unknown[] = [];
  const runtime = new ContentEditorPluginRuntime({
    inventory: f.store,
    brokerStore: store,
    broker,
    parentOrigin: 'http://localhost:4179',
    now: () => now,
    onFailure: (report) => reports.push(report),
    packages: {
      resolveInstalledPackage: async (digest: string) => {
        const pkg = await locator.resolveInstalledPackage(digest);
        root = pkg.rootDir;
        const { verifyStaticIntegrity, ...executable } = pkg;
        return {
          ...executable,
          verifyIntegrity: async () => {
            fullReads++;
            now += fullDelay;
            if (rejectStartup) throw new Error('startup byte verification failed');
            await pkg.verifyIntegrity();
          },
          ...(sealed
            ? {
                verifyStaticIntegrity: async () => {
                  sealReads++;
                  assert.ok(verifyStaticIntegrity);
                  await verifyStaticIntegrity();
                },
              }
            : {}),
        };
      },
    },
  });
  t.after(async () => {
    await runtime.stop(id, 'test_cleanup');
    await f.cleanup();
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  if (rejectStartup) await assert.rejects(runtime.start(id));
  else await runtime.start(id);
  return {
    f,
    id,
    runtime,
    reports,
    store,
    root: () => root,
    reads: () => ({ full: fullReads, seal: sealReads }),
    setFullDelay: (milliseconds: number) => {
      fullDelay = milliseconds;
    },
    setTime: (value: number) => {
      now = value;
    },
  };
}

test('ready editor authority uses a fresh static seal while startup still verifies complete bytes', async (t) => {
  const f = await integrityFixture(t);
  const initial = f.reads();
  assert.ok(initial.full >= 3, 'startup must retain complete byte checks around the Host asset snapshot');
  assert.equal(initial.seal, 0, 'provisional startup authority must retain byte verification');
  const handle = await f.runtime.resolve(f.id, 'docx');
  assert.ok(handle);
  await f.runtime.features.run(handle.executionLease, async () => undefined);
  assert.equal(f.reads().full, initial.full, 'ready authority must not reread and hash the entire package');
  assert.ok(f.reads().seal >= 2, 'each warm authority use must revalidate the sealed generation');
});

test('a valid static editor renews without paying a slow executable byte scan on every heartbeat', async (t) => {
  const f = await integrityFixture(t);
  const initial = f.reads();
  f.setFullDelay(24_750);
  f.setTime(11_074);
  t.mock.timers.tick(10_000);
  const deadline = performance.now() + 5_000;
  while (f.reads().seal === initial.seal && f.reads().full === initial.full && performance.now() < deadline)
    await turn();
  // Resolve joins real verification and checks the same Broker authority after the heartbeat work.
  assert.ok(await f.runtime.resolve(f.id, 'docx'), 'a valid frozen editor must retain its unexpired authority');
  const current = (await f.f.store.snapshot()).instances.find((instance) => instance.pluginInstanceId === f.id);
  assert.equal(current?.runtimeState, 'healthy');
  assert.equal(f.reads().full, initial.full, 'heartbeat must use the static verifier');
  assert.ok(f.reads().seal > initial.seal);
  assert.equal(f.reports.length, 0);
});

test('same-size tampering with restored mtime revokes the warm editor and cannot revive the damaged generation', async (t) => {
  const f = await integrityFixture(t);
  const handle = await f.runtime.resolve(f.id, 'docx');
  assert.ok(handle);
  const path = join(f.root(), 'renderer/index.html');
  const original = await readFile(path);
  const before = await stat(path);
  const changed = Buffer.from(original);
  changed[changed.length - 1] ^= 1;
  await writeFile(path, changed);
  await utimes(path, before.atime, before.mtime);
  assert.equal(await f.runtime.resolve(f.id, 'docx'), undefined);
  await assert.rejects(f.runtime.features.run(handle.executionLease, async () => assert.fail('stale effect')));
  await writeFile(path, original);
  await utimes(path, before.atime, before.mtime);
  assert.equal(
    await f.runtime.resolve(f.id, 'docx'),
    undefined,
    'restoring bytes cannot reseal the damaged generation',
  );
  assert.equal((await f.store.snapshot()).staticFeatures?.epochs[0]?.state, 'damaged');
});

test('a locator without static proof retains full byte verification for warm authority', async (t) => {
  const f = await integrityFixture(t, false);
  const initial = f.reads();
  assert.ok(await f.runtime.resolve(f.id, 'docx'));
  assert.ok(f.reads().full > initial.full);
  assert.equal(f.reads().seal, 0);
});

test('static proof cannot replace byte verification while an editor is starting', async (t) => {
  const f = await integrityFixture(t, true, true);
  assert.ok(f.reads().full > 0);
  assert.equal(f.reads().seal, 0);
  assert.equal(await f.runtime.resolve(f.id, 'docx'), undefined);
});
