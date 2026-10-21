import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { type TestContext, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ContentEditorSemanticWorker } from '../src/domains/plugin/content-editor-runtime/semantic-worker.js';
import { OfficialPluginPackageInstaller } from '../src/domains/plugin/official-package-installer.js';
import { createDormantPluginRuntimeComposition } from '../src/domains/plugin/runtime-composition.js';
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
  const result = await runtime.editorWorkers!.execute(authority, request);
  assert.equal(result.response.result.kind, 'inspection');
  assert.equal(result.metrics.disposed, true);
  assert.equal(result.metrics.externalRequests, 0);
  await assert.rejects(
    runtime.editorWorkers!.execute({ ...authority, executionLeaseDigest: 'sha256:stale' }, request),
    /authority changed/,
  );
  await assert.rejects(
    runtime.editorWorkers!.execute(authority, { ...request, requestId: '' }),
    /invalid editor worker/,
  );
});

test('disable actively aborts the private worker and denies new or late computations', async (t) => {
  const { runtime, authority, enabled } = await setup(t, 'self.onmessage=()=>{while(true){}};');
  const work = runtime.editorWorkers!.execute(authority, request);
  const rejected = assert.rejects(work, /revoked|abort|closed|changed|exited/i);
  await assert.rejects(runtime.editorWorkers!.execute(authority, request), /busy/);
  await delay(1000);
  await runtime.lifecycle.disable(authority.installationInstanceId, enabled.lifecycleRevision);
  await rejected;
  await assert.rejects(runtime.editorWorkers!.execute(authority, request), /authority changed/);
});

test('declared SRI mismatch and malformed public output never become successful documents', async (t) => {
  const mismatch = await setup(t, success, `sha256-${Buffer.alloc(32).toString('base64')}`);
  await assert.rejects(mismatch.runtime.editorWorkers!.execute(mismatch.authority, request), /integrity mismatch/);
  const malicious = await setup(
    t,
    'self.onmessage=e=>self.postMessage({protocolVersion:"1.0.0",requestId:e.data.requestId,result:{kind:"applied",receiptId:"forged"}});',
  );
  await assert.rejects(
    malicious.runtime.editorWorkers!.execute(malicious.authority, request),
    /invalid public editor worker response/,
  );
});

test('revocation during package release rejects the result and completes abortAndWait', async (t) => {
  const { runtime, authority } = await setup(t);
  const releaseEntered = Promise.withResolvers<void>();
  const releaseGate = Promise.withResolvers<void>();
  t.after(() => releaseGate.resolve());
  const worker = new ContentEditorSemanticWorker({
    editors: runtime.contentEditors!,
    packages: {
      async resolveInstalledPackage(digest) {
        const pkg = await runtime.packages.resolveInstalledPackage(digest);
        return {
          ...pkg,
          async release() {
            releaseEntered.resolve();
            await releaseGate.promise;
            await pkg.release();
          },
        };
      },
    },
  });
  const outcome = worker.execute(authority, request).then(
    () => ({ status: 'fulfilled' as const }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  );
  await releaseEntered.promise;
  let abortCompleted = false;
  const abort = worker.abortAndWait(authority.installationInstanceId).then(() => {
    abortCompleted = true;
  });
  await assert.rejects(worker.execute(authority, request), /busy/);
  assert.equal(abortCompleted, false);
  releaseGate.resolve();
  const [result] = await Promise.all([outcome, abort]);
  assert.equal(abortCompleted, true);
  assert.equal(result.status, 'rejected', 'revoked result must not escape asynchronous release');
  if (result.status === 'rejected') assert.match(String(result.error), /authority revoked/);
});
