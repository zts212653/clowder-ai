import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configEventBus, createChangeSetId } from '../dist/config/config-event-bus.js';
import { createCloudConversationComposition } from '../dist/domains/cats/services/cloud-bridge/plugin-conversation-host/cloud-conversation-composition.js';
import { catConfig, manualScheduler } from './helpers/f202-return-poller-harness.js';

const change = () =>
  configEventBus.emitChangeAsync({
    source: 'cat-config',
    scope: 'domain',
    changedKeys: ['removed-member'],
    changeSetId: createChangeSetId(),
    timestamp: Date.now(),
  });

test('production catalog changes wait for routing, but finish while prompt warmup is pending', async (t) => {
  let releaseRouting, releaseWarm;
  const routing = new Promise((resolve) => {
    releaseRouting = resolve;
  });
  const warm = new Promise((resolve) => {
    releaseWarm = resolve;
  });
  let ready = false;
  let warming = false;
  let finished = false;
  const cloud = createCloudConversationComposition({
    cats: catConfig({}),
    scheduler: manualScheduler(),
    ingestService: { ingest: async () => assert.fail('no cloud return expected') },
    grantPersistence: 'ephemeral',
    logger: { info() {}, warn() {} },
    catalogLog: { info() {}, warn() {} },
    async reconcileCats() {
      await routing;
      ready = true;
    },
    warmCats() {
      assert.equal(ready, true, 'routing must be updated before warming');
      warming = true;
      return warm;
    },
  });
  t.after(() => {
    releaseRouting();
    releaseWarm();
    cloud.stop();
  });
  cloud.start();
  const work = change().then(() => {
    finished = true;
  });
  await new Promise(setImmediate);
  assert.equal(finished, false, 'deletion must wait for routing readiness');
  assert.equal(warming, false);
  releaseRouting();
  await new Promise(setImmediate);
  assert.equal(warming, true, 'the production composition must forward the background warmup');
  assert.equal(finished, true, 'deletion must finish without waiting for prompt subprocesses');
  await work;
});

test('failed background warmup warns without failing or blocking subsequent catalog changes', async (t) => {
  const warnings = [];
  let reconciles = 0;
  const cloud = createCloudConversationComposition({
    cats: catConfig({}),
    scheduler: manualScheduler(),
    ingestService: { ingest: async () => assert.fail('no cloud return expected') },
    grantPersistence: 'ephemeral',
    logger: { info() {}, warn() {} },
    catalogLog: { info() {}, warn: (...args) => warnings.push(args) },
    async reconcileCats() {
      reconciles++;
    },
    async warmCats() {
      throw new Error('test compiler unavailable');
    },
  });
  t.after(() => cloud.stop());
  cloud.start();
  await change();
  await new Promise(setImmediate);
  await change();
  await new Promise(setImmediate);
  assert.equal(reconciles, 2);
  assert.equal(warnings.length, 2, 'each warmup failure must remain visible');
  assert.match(warnings[0][0], /Background warmup failed/);
  cloud.stop();
  await change();
  assert.equal(reconciles, 2, 'shutdown must unsubscribe the catalog listener');
});
