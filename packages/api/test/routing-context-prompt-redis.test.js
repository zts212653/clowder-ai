import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { createRedisClient } from '@cat-cafe/shared/utils';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';
import { createRoutingContextRuntime, ownerId, primaryCatId } from './helpers/routing-dossier-composition-fixture.js';

const { RoutingSignalEventKeys: keys } = await import(
  '../dist/domains/routing-context/RedisRoutingSignalEventStore.js'
);
const { buildRoutingSignalDecisionProjection } = await import(
  '../dist/domains/routing-context/preflight/RoutingSignalDecisionProjection.js'
);

// Seed only this isolated client's keyspace, including replay/subject/sequence indexes.
async function seedHistory(redis, events) {
  for (let offset = 0; offset < events.length; offset += 500) {
    const batch = redis.pipeline();
    for (const [index, event] of events.slice(offset, offset + 500).entries()) {
      const raw = JSON.stringify(event);
      batch.set(keys.detail(ownerId, event.eventId), raw);
      batch.set(keys.command(ownerId, event.commandId), raw);
      batch.zadd(keys.ownerTimeline(ownerId), event.observedAt, event.eventId);
      batch.zadd(keys.subjectTimeline(ownerId, event.subjectRef), event.observedAt, event.eventId);
      batch.zadd(keys.ownerAppendSequence(ownerId), offset + index + 1, event.eventId);
    }
    for (const [error] of await batch.exec()) assert.equal(error, null);
  }
  await redis.set(keys.ownerRevision(ownerId), events.length);
  const projection = buildRoutingSignalDecisionProjection({ ownerId, revision: events.length, events });
  await redis.set(keys.decisionProjection(ownerId), JSON.stringify(projection));
}

test(
  'real invocation prompt uses the persisted decision projection across a 29,751-event ledger and restart',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async (t) => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'routing prompt Redis read');
    t.mock.method(Date, 'now', () => 50_000);
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: 'f293-prompt-redis-test:' });
    const projectRoot = mkdtempSync(join(tmpdir(), 'f293-prompt-redis-'));
    t.after(async () => {
      await cleanupClientKeyspace(redis);
      await redis.quit();
      rmSync(projectRoot, { recursive: true, force: true });
    });
    const createRuntime = () =>
      createRoutingContextRuntime({
        redis,
        projectRoot,
        getConfigs: () => ({ [primaryCatId]: catRegistry.getOrThrow(primaryCatId).config }),
      });
    const open = {
      v: 1,
      ownerId,
      eventId: 'manual:open',
      commandId: 'command:manual:open',
      subjectRef: { type: 'cat', catId: primaryCatId },
      source: 'manual_cvo',
      reasonCode: 'manual_limit',
      observedAt: 1_000,
      evidenceRef: 'message:manual-limit',
      eventType: 'asserted',
      state: 'scarce',
      validUntil: 90_000,
      resetAt: 80_000,
    };
    const events = [
      open,
      ...Array.from({ length: 29_750 }, (_, index) => ({
        v: 1,
        ownerId,
        eventId: `success:${index}`,
        commandId: `command:success:${index}`,
        subjectRef: open.subjectRef,
        source: 'dispatch_success',
        reasonCode: 'dispatch_success_probe',
        note: 'Synthetic historical dispatch success; retains the causal recovery frontier for exact-member probes.',
        observedAt: 2_000 + index,
        probeStartedAt: 1_500 + index,
        evidenceRef: `turn:success:${index}`,
        eventType: 'recovered',
        state: 'available',
        closesSignalIds: [],
      })),
    ];
    await seedHistory(redis, events);
    let commands = [];
    const originalSendCommand = redis.sendCommand;
    t.mock.method(redis, 'sendCommand', function (command, ...args) {
      commands.push({ name: command.name, args: [...command.args] });
      return originalSendCommand.call(this, command, ...args);
    });

    const previousConsumer = createRuntime();
    const auditStarted = performance.now();
    const audit = await previousConsumer.readService.read({ ownerId, observedAt: 50_000 });
    const oldAdvisory = JSON.parse(previousConsumer.promptProjector.project(audit).split('\n')[2]);
    const auditMs = performance.now() - auditStarted;
    assert.ok(commands.some((command) => command.name === 'mget' && command.args.length === events.length));
    assert.equal(oldAdvisory.anomalies[0].availability, 'scarce');
    assert.equal(oldAdvisory.anomalies[0].validUntil, undefined, 'the old history window reproduces the omission');

    // New process graph: no resolver/store cache can hide a cold full-history read.
    const runtime = createRuntime();
    commands = [];
    const coldStarted = performance.now();
    const projection = await runtime.promptProjection.resolve({ ownerId });
    const coldMs = performance.now() - coldStarted;
    const advisory = JSON.parse(projection.split('\n')[2]);
    assert.equal(advisory.anomalies[0].validUntil, open.validUntil);
    assert.equal(advisory.anomalies[0].resetAt, open.resetAt);
    assert.ok(
      commands.some((command) => command.name === 'get' && command.args[0].endsWith(keys.decisionProjection(ownerId))),
    );
    assert.ok(
      commands.every(
        (command) =>
          !(command.name === 'zrange' && command.args[0].endsWith(keys.ownerTimeline(ownerId))) &&
          !(command.name === 'mget' && command.args.some((key) => key.includes(':signals:'))),
      ),
      'cold prompt must not enumerate the event timeline or hydrate event detail keys',
    );
    const coldCommandCount = commands.length;
    commands = [];
    for (let index = 0; index < 3; index++) {
      assert.equal(await runtime.promptProjection.resolve({ ownerId }), projection);
    }
    assert.equal(commands.length, 0, 'warm prompt should reuse revision-fenced process decision state');

    const retract = {
      ...open,
      eventId: 'manual:retract',
      commandId: 'command:manual:retract',
      eventType: 'retracted',
      observedAt: 50_000,
      closesSignalIds: [open.eventId],
    };
    delete retract.state;
    delete retract.validUntil;
    delete retract.resetAt;
    assert.equal((await runtime.signalStore.append(retract)).outcome, 'appended');
    assert.equal((await runtime.signalStore.append(retract)).outcome, 'replayed');
    commands = [];
    assert.equal(await runtime.promptProjection.resolve({ ownerId }), '');
    assert.equal(commands.length, 0, 'same-process revision changes stay on decision state');
    assert.equal(await redis.zcard(keys.ownerTimeline(ownerId)), events.length + 1, 'history is retained');
    t.diagnostic(
      JSON.stringify({
        syntheticEventCount: events.length,
        syntheticLedgerBytes: events.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)), 0),
        auditMgetKeys: events.length,
        promptEventMgetKeys: 0,
        coldCommandCount,
        auditMs,
        coldPromptMs: coldMs,
      }),
    );
  },
);
