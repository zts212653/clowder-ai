import assert from 'node:assert/strict';
import fs from 'node:fs';
import { lstat, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { containStaticFeatureEpoch } from '../src/domains/plugin/host-broker/static-feature-ledger.js';
import './helpers/setup-cat-registry.js';
import { integrityPollFixture } from './helpers/f317-integrity-poll.fixture.js';

test('successful owner polling checks authority without rehashing unchanged staged package bytes', async (t) => {
  const f = await integrityPollFixture(t, true);
  const createReadStream = fs.createReadStream;
  let streams = 0;
  let bytes = 0;
  t.mock.method(fs, 'createReadStream', (...args: Parameters<typeof createReadStream>) => {
    const stream = createReadStream(...args);
    if (String(args[0]).startsWith(f.stagedRoot)) {
      streams++;
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
      });
    }
    return stream;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const started = performance.now();
  for (const kind of ['state', 'transcript.read', 'conversation.read']) {
    const result = await f.request({ kind });
    assert.notEqual(result.kind, 'error', `${kind} must succeed through the real bridge`);
  }
  t.diagnostic(JSON.stringify({ streams, bytes, elapsedMs: performance.now() - started, packageFiles: 61 }));
  assert.equal(streams, 0, 'unchanged static execution must reuse its admitted byte proof, not reread bytes');
});

for (const mutation of ['same-bytes', 'same-size-restored-mtime', 'replacement', 'symlink', 'extra-file'] as const) {
  test(`${mutation} damages the static execution epoch and cannot revive by restoring bytes`, async (t) => {
    const f = await integrityPollFixture(t);
    const path = join(f.stagedRoot, 'renderer/index.html');
    const original = await readFile(path);
    const stamp = await lstat(path);
    if (mutation === 'same-bytes') await writeFile(path, original);
    if (mutation === 'same-size-restored-mtime') {
      await writeFile(path, Buffer.alloc(original.length, 'x'));
      await utimes(path, stamp.atime, stamp.mtime);
    }
    if (mutation === 'replacement' || mutation === 'symlink') {
      await rename(path, `${path}.old`);
      if (mutation === 'replacement') await writeFile(path, original);
      else await symlink(`${path}.old`, path);
    }
    if (mutation === 'extra-file') await writeFile(join(f.stagedRoot, 'added.txt'), 'unadmitted');
    assert.equal((await f.request({ kind: 'state' })).kind, 'error');
    const ledger = (await f.runtime.brokerStore.snapshot()).staticFeatures;
    assert.ok(ledger);
    assert.equal(ledger.epochs.at(-1)?.state, 'damaged');
    assert.equal(ledger.leases.at(-1)?.state, 'revoked');
    await rm(path, { force: true });
    await writeFile(path, original);
    assert.equal((await f.request({ kind: 'state' })).kind, 'error');
  });
}

test('concurrent unchanged polls preserve the seal while a damaged durable epoch still rejects them', async (t) => {
  const f = await integrityPollFixture(t);
  const replies = await Promise.all(Array.from({ length: 8 }, () => f.request({ kind: 'state' })));
  assert.ok(replies.every((reply) => reply.kind === 'state'));
  await f.runtime.brokerStore.transaction((tx) => {
    const ledger = tx.staticFeatures.get();
    const epoch = ledger.epochs.at(-1);
    assert.ok(epoch);
    tx.staticFeatures.put(containStaticFeatureEpoch(ledger, f.installed.pluginInstanceId, epoch.integrityEpoch, 2000));
  });
  assert.equal((await f.request({ kind: 'state' })).kind, 'error');
});

test('owner disable during a successful owner HTTP read fences the reply after the last seal check', async (t) => {
  const f = await integrityPollFixture(t);
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.blockOwnerRead(async () => {
    enter();
    await blocked;
  });
  const pending = f.request({ kind: 'state' });
  await entered;
  await f.runtime.inventoryStore.transaction((tx) => {
    const instance = tx.instances.get(f.installed.pluginInstanceId)!;
    tx.instances.put({ ...instance, activationState: 'disabled', lifecycleRevision: instance.lifecycleRevision + 1 });
  });
  release();
  assert.equal((await pending).kind, 'error');
  assert.equal((await f.runtime.brokerStore.snapshot()).staticFeatures?.leases.at(-1)?.state, 'revoked');
});

test('closing a desktop while an owner HTTP read is pending cannot return a successful late reply', async (t) => {
  const f = await integrityPollFixture(t);
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.blockOwnerRead(async () => {
    enter();
    await blocked;
  });
  const pending = f.request({ kind: 'state' });
  await entered;
  await f.runtime.supervisor.stop(f.installed.pluginInstanceId, 'test-owner-close');
  release();
  assert.equal((await pending).kind, 'error');
});
