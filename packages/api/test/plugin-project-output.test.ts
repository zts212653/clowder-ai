import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { PluginManifest } from '@clowder-ai/plugin-contract';
import { FileMessagingMediaLedger } from '../src/domains/messaging/media-ledger.js';
import { createModuleHostInvocation } from '../src/domains/plugin/builtin-runtime/carriers/module-host-invocation.js';
import { withPluginCallContext } from '../src/domains/plugin/carrier/plugin-call-context.js';
import {
  type PluginRuntimeAdmission,
  PluginRuntimeCarrierRouter,
} from '../src/domains/plugin/carrier/runtime-carrier.js';
import { HostInventoryControlPlane } from '../src/domains/plugin/host-inventory/control-plane.js';
import { MemoryPluginInventoryStore } from '../src/domains/plugin/host-inventory/stores.js';
import { HostMediaSourceImporter } from '../src/domains/plugin/media-source-importer.js';
import { PluginProjectOutputs } from '../src/domains/plugin/outputs/project-output-actions.js';

const manifest: PluginManifest = {
  pluginId: 'fixture.music-output',
  version: '0.1.0',
  contractVersion: '0.3.1-candidate.0',
  name: 'Music output fixture',
  runtime: { transport: 'builtin', entrypoint: 'dist/index.js' },
  features: [
    {
      id: 'music',
      name: 'Music',
      resources: [],
      contributions: [
        { type: 'identity', id: 'music' },
        { type: 'media-source', id: 'audio' },
        { type: 'mcp', id: 'native' },
      ],
    },
  ],
  contributions: [
    { type: 'identity', id: 'music', displayName: 'Music' },
    { type: 'media-source', id: 'audio', binding: 'music' },
    {
      type: 'mcp',
      id: 'native',
      runtime: { transport: 'stdio', entrypoint: 'dist/mcp.js' },
    },
  ],
  projectOutputs: [
    {
      method: 'music.output',
      producerMethod: 'music.generate',
      resultMethod: 'music.result',
      mcpId: 'native',
      mediaSourceId: 'audio',
      mimeType: 'audio/mpeg',
      maxBytes: 1_048_576,
    },
  ],
};
const audio = Buffer.from('ID3fixture-produced-audio');
const caller = () => ({
  catId: 'cat-one',
  threadId: 'thread-one',
  userId: 'owner-one',
  invocationId: 'inv-one',
  ownerAuthProvenance: 'strict' as const,
  assertCurrent: async () => {},
});

async function harness(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-native-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inventory = new MemoryPluginInventoryStore();
  const control = new HostInventoryControlPlane(inventory, { createInstanceId: () => 'pi_music' });
  const packageDigest = `sha512-${createHash('sha512').update('fixture archive').digest('base64')}`;
  const installed = await control.installPackage({
    manifest,
    computedPackageDigest: packageDigest,
    expectedPackageDigest: packageDigest,
    packagePluginId: manifest.pluginId,
    signalSchemas: {},
  });
  await inventory.transaction((tx) => {
    const row = tx.instances.get(installed.pluginInstanceId)!;
    tx.instances.put({ ...row, configReadiness: 'ready', activationState: 'enabled' });
  });
  const ledger = new FileMessagingMediaLedger(join(root, '.media'));
  const produced = new Map<string, unknown>();
  let paid = 0;
  let unknown = false;
  let threadOwner = 'owner-one';
  const invocation = createModuleHostInvocation({
    runtime: {
      actions: () => ({
        'music.generate': async (parameters: unknown, context: { outputOperation?: { id: string } }) => {
          assert.ok(context.outputOperation?.id.startsWith('out_'));
          assert.deepEqual(parameters, { prompt: 'Piano' });
          paid++;
          if (unknown) return { state: 'generation_unknown', retryable: false };
          produced.set(context.outputOperation.id, {
            state: 'produced',
            media: {
              sourceId: 'audio',
              reference: 'pmr_music_fixture',
              mimeType: 'audio/mpeg',
              bytes: audio.length,
              sha256: createHash('sha256').update(audio).digest('hex'),
            },
            provenance: {
              model: 'fixture',
              prompt: 'Piano',
              timestamp: new Date(0).toISOString(),
              actualChargedUsd: null,
            },
          });
          return { state: 'pending', retryable: false };
        },
        'music.result': async (_input: unknown, context: { outputOperation: { id: string } }) =>
          produced.get(context.outputOperation.id) ?? { state: 'generation_unknown', retryable: false },
      }),
    },
  });
  const importer = new HostMediaSourceImporter({
    ledger,
    resolveManifest: async () => manifest,
    read: async function* () {
      yield audio;
    },
  });
  const outputs = new PluginProjectOutputs({
    root: join(root, '.outputs'),
    importer,
    ledger,
    threads: { get: async () => ({ createdBy: threadOwner, projectPath: root }) },
  });
  const router = new PluginRuntimeCarrierRouter(inventory, undefined, undefined, undefined, outputs);
  const rawInvocations: string[] = [];
  router.register({
    claims: () => true,
    start: async () => {},
    stop: async () => {},
    invoke: (id, method, input) => {
      rawInvocations.push(method);
      return invocation.invoke(id, method, input);
    },
  });
  const snapshot = await inventory.snapshot();
  const admission = {
    instance: snapshot.instances[0]!,
    packageRecord: snapshot.packages[0]!,
  } as PluginRuntimeAdmission;
  router.nativeActions.activate(admission, 0, (method, input) =>
    router.invoke(installed.pluginInstanceId, method, input),
  );
  const token = router.nativeActions.environment(installed.pluginInstanceId, 'native').CLOWDER_PLUGIN_ACTION_TOKEN!;
  const call = (input: unknown, identity = caller()) =>
    router.nativeActions.call(token, 'music.output', input, identity);
  return {
    root,
    router,
    rawInvocations,
    directOutput: (input: unknown) =>
      withPluginCallContext(installed.pluginInstanceId, caller(), () =>
        outputs.call(
          installed.pluginInstanceId,
          'music.output',
          input,
          async () => ({ ...admission, instance: (await inventory.snapshot()).instances[0]! }),
          (method, parameters) => invocation.invoke(installed.pluginInstanceId, method, parameters),
        ),
      ),
    setEnabled: (enabled: boolean) =>
      inventory.transaction((tx) => {
        const row = tx.instances.get(installed.pluginInstanceId)!;
        tx.instances.put({ ...row, activationState: enabled ? 'enabled' : 'disabled' });
      }),
    call,
    paid: () => paid,
    unknown: () => {
      unknown = true;
    },
    setOwner: (owner: string) => {
      threadOwner = owner;
    },
  };
}
const request = () => ({ requestId: 'owner-request-one', outputPath: 'score.mp3', parameters: { prompt: 'Piano' } });

test('native action reserves before generation, polls and delivers both files through Host media ownership', async (t) => {
  const h = await harness(t);
  const first = (await h.call(request())) as { state: string };
  assert.equal(first.state, 'pending');
  const delivered = (await h.call(request())) as { state: string };
  assert.equal(delivered.state, 'delivered');
  assert.equal(h.paid(), 1);
  assert.equal(await readFile(join(h.root, 'score.mp3'), 'utf8'), audio.toString());
  const receipt = JSON.parse(await readFile(join(h.root, 'score.mp3.provenance.json'), 'utf8'));
  assert.equal(receipt.actualChargedUsd, null);
  assert.equal(receipt.delivery.pluginInstanceId, 'pi_music');
  assert.equal(((await h.call(request())) as { state: string }).state, 'delivered');
  assert.equal(h.paid(), 1);
  await assert.rejects(h.call({ ...request(), outputPath: 'another.mp3' }), /operation_conflict/);
  assert.equal(h.paid(), 1);
});
test('existing sidecar and unauthenticated entrypoints never reach the producer', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.root, 'score.mp3.provenance.json'), 'existing');
  assert.equal(((await h.call(request())) as { state: string }).state, 'rejected');
  assert.equal(h.paid(), 0);
  await assert.rejects(
    h.router.invoke('pi_music', 'music.output', { ...request(), requestId: 'untrusted' }),
    /authenticated_output_caller_required/,
  );
  assert.equal(h.paid(), 0);
});
test('output producer and lookup are Host-internal even without a native MCP method allowlist', async (t) => {
  const h = await harness(t);
  for (const method of ['music.generate', 'music.result']) {
    await assert.rejects(h.router.invoke('pi_music', method, {}), /output_internal_method/);
    assert.equal(await h.router.exposesAction('pi_music', method), false);
  }
  assert.deepEqual(h.rawInvocations, []);
  assert.equal(h.paid(), 0);
});
test('output admission follows live installation and caller authority without a duplicate API grant', async (t) => {
  const h = await harness(t);
  await h.setEnabled(false);
  await assert.rejects(h.directOutput(request()), /output_permission_denied/);
  assert.equal(h.paid(), 0);
  await h.setEnabled(true);
  assert.equal(((await h.directOutput(request())) as { state: string }).state, 'pending');
  assert.equal(((await h.directOutput(request())) as { state: string }).state, 'delivered');
  assert.equal(h.paid(), 1);
});
test('unknown provider completion is retained and cannot trigger another paid dispatch', async (t) => {
  const h = await harness(t);
  h.unknown();
  assert.equal(((await h.call(request())) as { state: string }).state, 'generation_unknown');
  assert.equal(((await h.call(request())) as { state: string }).state, 'generation_unknown');
  assert.equal(h.paid(), 1);
});
test('concurrent native calls for the same operation share reservation and never reject their own winner', async (t) => {
  const h = await harness(t);
  const results = (await Promise.all([h.call(request()), h.call(request())])) as Array<{ state: string }>;
  assert.equal(
    results.some((result) => result.state === 'rejected'),
    false,
  );
  assert.equal(h.paid(), 1);
  assert.equal(((await h.call(request())) as { state: string }).state, 'delivered');
});
test('thread ownership is checked before generation and again before delivery-only recovery', async (t) => {
  const h = await harness(t);
  h.setOwner('another-owner');
  await assert.rejects(h.call(request()), /output_project_forbidden/);
  assert.equal(h.paid(), 0);
  h.setOwner('owner-one');
  assert.equal(((await h.call(request())) as { state: string }).state, 'pending');
  h.setOwner('another-owner');
  await assert.rejects(h.call(request()), /output_project_forbidden/);
  assert.equal(h.paid(), 1);
  h.setOwner('owner-one');
  assert.equal(((await h.call(request())) as { state: string }).state, 'delivered');
  assert.equal(h.paid(), 1);
});
