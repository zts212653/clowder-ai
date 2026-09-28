import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { type TestContext, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { OfficialPluginPackageInstaller } from '../src/domains/plugin/official-package-installer.js';
import { createDormantPluginRuntimeComposition } from '../src/domains/plugin/runtime-composition.js';
import { MemoryMeetingIntakeStore } from '../src/domains/signal-intake/MeetingIntakeStore.js';
import { MemorySignalRouteStore } from '../src/domains/signal-intake/SignalRouteStore.js';
import { staticEditorFixture, staticEditorManifest } from './plugin-static-editor.fixture.js';

const request = {
  protocolVersion: '1.0.0' as const,
  requestId: 'broker-test',
  mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' as const,
  bytesBase64: 'UEs=',
  operation: { kind: 'inspect' as const, cursor: 0, limit: 4 },
};
const success =
  'self.onmessage=e=>self.postMessage({protocolVersion:"1.0.0",requestId:e.data.requestId,result:{kind:"inspection",paragraphs:[],nextCursor:null}});';

async function setup(t: TestContext, worker = success, declaredIntegrity?: string) {
  const manifest = staticEditorManifest();
  const contribution = manifest.contributions![0];
  assert.equal(contribution.type, 'content-editor-provider');
  if (contribution.type !== 'content-editor-provider') throw new Error('fixture');
  contribution.semanticMaterializer = {
    executionClass: 'dedicated-browser-worker',
    entrypoint: 'renderer/worker.js',
    integrity: declaredIntegrity ?? `sha256-${createHash('sha256').update(worker).digest('base64')}`,
    protocolVersion: '1.0.0',
  };
  const fixture = await staticEditorFixture(manifest, undefined, worker);
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot: fixture.root,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    editorParentOrigin: 'http://localhost:4179',
  });
  t.after(async () => {
    await runtime.shutdown();
    await fixture.cleanup();
  });
  const installer = new OfficialPluginPackageInstaller({
    inventory: runtime.inventory,
    packagesRoot: runtime.paths.packagesRoot,
    catalog: [fixture.entry],
    fetchArchive: async () => fixture.bytes,
  });
  const installed = await installer.install(fixture.entry.catalogId, fixture.entry);
  const instance = (await runtime.inventoryStore.snapshot()).instances.find(
    (value) => value.pluginInstanceId === installed.pluginInstanceId,
  )!;
  const prepared = await runtime.lifecycle.prepare(installed.pluginInstanceId, instance.lifecycleRevision);
  const enabled = await runtime.lifecycle.enable(installed.pluginInstanceId, prepared.lifecycleRevision);
  const handle = await runtime.contentEditors!.resolve(installed.pluginInstanceId, 'docx');
  assert.ok(handle);
  const authority = {
    installationInstanceId: installed.pluginInstanceId,
    providerId: 'docx',
    packageDigest: handle.packageDigest,
    providerVersion: handle.providerVersion,
    grantRevision: handle.grantRevision,
    lifecycleRevision: handle.lifecycleRevision,
    executionLeaseDigest: `sha256:${createHash('sha256').update(handle.executionLease).digest('hex')}`,
  };
  return { runtime, authority, enabled };
}

test('installed/enabled Broker lease and exact worker integrity gate every materialization', async (t) => {
  const { runtime, authority } = await setup(t);
  const result = await runtime.contentMaterializers!.execute(authority, request);
  assert.equal(result.response.result.kind, 'inspection');
  assert.equal(result.metrics.disposed, true);
  assert.equal(result.metrics.externalRequests, 0);
  await assert.rejects(
    runtime.contentMaterializers!.execute({ ...authority, executionLeaseDigest: 'sha256:stale' }, request),
    /authority changed/,
  );
  await assert.rejects(
    runtime.contentMaterializers!.execute(authority, { ...request, requestId: '' }),
    /invalid public/,
  );
});

test('disable actively aborts the private worker and denies new or late computations', async (t) => {
  const { runtime, authority, enabled } = await setup(t, 'self.onmessage=()=>{while(true){}};');
  const work = runtime.contentMaterializers!.execute(authority, request);
  const rejected = assert.rejects(work, /revoked|abort|closed|changed|exited/i);
  await assert.rejects(runtime.contentMaterializers!.execute(authority, request), /busy/);
  await delay(1000);
  await runtime.lifecycle.disable(authority.installationInstanceId, enabled.lifecycleRevision);
  await rejected;
  await assert.rejects(runtime.contentMaterializers!.execute(authority, request), /authority changed/);
});

test('declared SRI mismatch and malformed public output never become successful documents', async (t) => {
  const mismatch = await setup(t, success, `sha256-${Buffer.alloc(32).toString('base64')}`);
  await assert.rejects(
    mismatch.runtime.contentMaterializers!.execute(mismatch.authority, request),
    /integrity mismatch/,
  );
  const malicious = await setup(
    t,
    'self.onmessage=e=>self.postMessage({protocolVersion:"1.0.0",requestId:e.data.requestId,result:{kind:"applied",receiptId:"forged"}});',
  );
  await assert.rejects(
    malicious.runtime.contentMaterializers!.execute(malicious.authority, request),
    /invalid public materializer response/,
  );
});
