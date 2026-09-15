import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { OfficialPluginPackageInstaller } from '../src/domains/plugin/official-package-installer.js';
import { createDormantPluginRuntimeComposition } from '../src/domains/plugin/runtime-composition.js';
import { MemoryMeetingIntakeStore } from '../src/domains/signal-intake/MeetingIntakeStore.js';
import { MemorySignalRouteStore } from '../src/domains/signal-intake/SignalRouteStore.js';
import { staticEditorFixture, staticEditorManifest } from './plugin-static-editor.fixture.js';

function fetchSurface(origin: string, path: string): Promise<{ status: number; body: string }> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: url.port, path, headers: { host: url.host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (b: Buffer) => chunks.push(b));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('real Host composition installs, enables and revokes a static editor through Broker feature leases', async (t) => {
  const f = await staticEditorFixture(staticEditorManifest());
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot: f.root,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    editorParentOrigin: 'http://localhost:4179',
  });
  t.after(async () => {
    await runtime.shutdown();
    await f.cleanup();
  });
  assert.ok(runtime.contentEditors, 'dormant composition must expose the Host editor resolver');
  assert.equal((await runtime.inventoryStore.snapshot()).instances.length, 0);
  const installer = new OfficialPluginPackageInstaller({
    inventory: runtime.inventory,
    packagesRoot: runtime.paths.packagesRoot,
    catalog: [f.entry],
    fetchArchive: async () => f.bytes,
  });
  const installed = await installer.install(f.entry.catalogId, f.entry);
  assert.equal(await runtime.contentEditors.resolve(installed.pluginInstanceId, 'docx'), undefined);
  const prepared = await runtime.lifecycle.prepare(installed.pluginInstanceId, 1);
  const enabled = await runtime.lifecycle.enable(installed.pluginInstanceId, prepared.lifecycleRevision);
  const handle = await runtime.contentEditors.resolve(installed.pluginInstanceId, 'docx');
  assert.ok(handle);
  assert.match(handle.executionLease, /^feature_/);
  assert.equal((await runtime.brokerStore.snapshot()).staticFeatures?.leases[0].state, 'active');
  const served = await fetchSurface(handle.rendererOrigin, handle.entrypointPath);
  assert.equal(served.status, 200);
  assert.match(served.body, /Static document editor/);
  await runtime.lifecycle.disable(installed.pluginInstanceId, enabled.lifecycleRevision);
  assert.equal(await runtime.contentEditors.resolve(installed.pluginInstanceId, 'docx'), undefined);
  await assert.rejects(
    runtime.contentEditors.features.run(handle.executionLease, async () => assert.fail('late owner effect')),
  );
  await assert.rejects(fetchSurface(handle.rendererOrigin, handle.entrypointPath));
});
