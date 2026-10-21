import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileMessagingMediaLedger } from '../dist/domains/messaging/media-ledger.js';
import { PluginMediaReadService } from '../dist/domains/plugin/host-surface/plugin-media-host.js';

test('stream readers return bytes, release on cancellation and allow reading the same attachment again', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-streams-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = new FileMessagingMediaLedger(root);
  const expected = Buffer.alloc(150000, 7);
  const reference = await ledger.register(expected);
  const service = new PluginMediaReadService({ ledger, entitlements: { isEntitled: async () => true } });
  const context = { pluginInstanceId: 'fixture', effectiveGrants: ['streams.read'] };
  const first = service.stream(context, reference)[Symbol.asyncIterator]();
  assert.ok((await first.next()).value instanceof Uint8Array);
  await first.return();
  const second = [];
  for await (const bytes of service.stream(context, reference)) second.push(bytes);
  assert.deepEqual(Buffer.concat(second), expected);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(async () => {
    for await (const _ of service.stream(context, reference, { signal: abort.signal })) {
    }
  }, /abort/i);
  await assert.rejects(async () => {
    for await (const _ of service.stream({ ...context, effectiveGrants: [] }, reference)) {
    }
  }, /streams.read/);
});

const { HostMediaSourceImporter } = await import('../dist/domains/plugin/media-source-importer.js');
test('plugin stream import uses the same reader contract and keeps source bytes reusable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-stream-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = new FileMessagingMediaLedger(root);
  let reads = 0,
    released = 0;
  const importer = new HostMediaSourceImporter({
    ledger,
    resolveManifest: async () => ({
      contributions: [
        { type: 'identity', id: 'channel' },
        { type: 'media-source', id: 'files', binding: 'channel' },
      ],
    }),
    read: async function* (_id, reference, { signal }) {
      assert.equal(reference, 'plugin-file');
      signal.throwIfAborted();
      reads++;
      try {
        yield new Uint8Array([1, 2]);
        yield new Uint8Array([3]);
      } finally {
        released++;
      }
    },
  });
  const input = {
    instanceId: 'fixture',
    sourceEventId: 'event',
    elementId: 'file',
    reference: 'plugin-file',
    sourceId: 'files',
    ingressIdentity: 'channel',
    type: 'file',
  };
  const first = await importer.import(input);
  assert.equal(first.kind, 'imported');
  assert.deepEqual(await importer.import(input), first);
  assert.equal(reads, 1);
  assert.equal((await importer.import({ ...input, sourceEventId: 'another' })).kind, 'imported');
  assert.equal(reads, 2);
  assert.equal(released, 2);
  assert.equal('settle' in importer, false);
});
