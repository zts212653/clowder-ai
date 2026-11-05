import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createCatCatalogSubscriber } from '../dist/config/cat-catalog-subscriber.js';
import { configEventBus, createChangeSetId } from '../dist/config/config-event-bus.js';
import { runSaveTrace, saveSpan } from '../dist/utils/member-save-diagnostics.js';

test('records a pending stage before completion, without changing results or exposing errors', async () => {
  const records = [];
  const traceId = randomUUID();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const context = {
    traceId,
    requestId: 'req-test',
    revision: 'test-build',
    log: { info: (record) => records.push(record) },
  };
  const work = runSaveTrace(context, () => saveSpan('catalog.write', () => gate));
  assert.equal(records[0]?.state, 'start');
  assert.equal(records[0]?.traceId, traceId);
  release(42);
  assert.equal(await work, 42);
  assert.equal(records.at(-1).state, 'finish');
  assert.ok(records.at(-1).durationMs >= 0);
  const failure = new Error('api_key=must-never-be-logged');
  assert.throws(
    () =>
      runSaveTrace(context, () =>
        saveSpan('catalog.write', () => {
          throw failure;
        }),
      ),
    (e) => e === failure,
  );
  assert.equal(records.at(-1).state, 'failed');
  assert.ok(!JSON.stringify(records).includes('api_key'));
});

test('concurrent saves keep queue waits and background warmups on their originating traces', async () => {
  const records = [];
  const ids = [randomUUID(), randomUUID()];
  let releaseFirst, releaseWarm;
  const first = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const warm = new Promise((resolve) => {
    releaseWarm = resolve;
  });
  let calls = 0;
  const sub = createCatCatalogSubscriber({
    onReconcile: () => (++calls === 1 ? first : Promise.resolve()),
    onWarm: () => warm,
    log: { info() {}, warn() {} },
  });
  try {
    const work = ids.map((traceId) =>
      runSaveTrace({ traceId, requestId: traceId, log: { info: (record) => records.push(record) } }, () =>
        configEventBus.emitChangeAsync({
          source: 'cat-config',
          scope: 'domain',
          changedKeys: ['test'],
          changeSetId: createChangeSetId(),
          timestamp: Date.now(),
        }),
      ),
    );
    await Promise.resolve();
    assert.ok(records.some((r) => r.traceId === ids[1] && r.phase === 'registry.queue' && r.state === 'start'));
    releaseFirst();
    await Promise.all(work);
    assert.equal(calls, 2);
    for (const id of ids) {
      assert.ok(records.some((r) => r.traceId === id && r.phase === 'registry.reconcile' && r.state === 'finish'));
      assert.ok(records.some((r) => r.traceId === id && r.phase === 'l0.warm' && r.background && r.state === 'start'));
      assert.ok(!records.some((r) => r.traceId === id && r.phase === 'l0.warm' && r.state === 'finish'));
    }
    releaseWarm();
    await new Promise((resolve) => setImmediate(resolve));
    for (const id of ids)
      assert.ok(records.some((r) => r.traceId === id && r.phase === 'l0.warm' && r.state === 'finish'));
  } finally {
    releaseFirst();
    releaseWarm();
    sub.unsubscribe();
  }
});

test('a broken diagnostic sink cannot fail a save', async () => {
  const result = runSaveTrace(
    {
      traceId: randomUUID(),
      requestId: 'req',
      log: {
        info() {
          throw Error('disk full');
        },
      },
    },
    () => saveSpan('catalog.write', () => Promise.resolve('saved')),
  );
  assert.equal(await result, 'saved');
});
