import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { buildHandedEvent, buildInvocationHeartbeatEvent } from '../dist/domains/ball-custody/ball-custody-events.js';
import {
  createA2ADispositionAuth as auth,
  createA2ADispositionHarness as harness,
} from './helpers/a2a-dispatch-disposition-harness.js';

const SUBJECT = 'ball:thread:thread-1';
const heartbeat = (at) =>
  buildInvocationHeartbeatEvent({
    threadId: 'thread-1',
    invocationId: 'inv-1',
    catId: 'codex-sol',
    draftUpdatedAt: at,
  });
const dispositions = async (h) =>
  (await h.eventLog.read(SUBJECT)).filter((event) => event.kind === 'ball.dispatch_dispositioned');

test('#1371 a heartbeat race completes the same dispatch after fresh validation', async () => {
  let attempts = 0;
  const warnings = [];
  const h = await harness({
    log: { warn: (fields) => warnings.push(fields) },
    beforeDispositionRecord: async ({ ingest }) => {
      attempts += 1;
      if (attempts === 1) await ingest.record(heartbeat(1_500));
    },
  });

  const result = await h.service.complete(auth(h), 'handled');

  assert.equal(result.outcome, 'applied');
  assert.equal(result.sourceMessageId, h.source.id);
  assert.equal(result.invocationId, 'inv-1');
  assert.equal(result.retired, false);
  assert.equal(attempts, 2);
  assert.equal((await dispositions(h)).length, 1);
  assert.equal((await h.projectionStore.get(SUBJECT)).state, 'resolved');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].expectedSequence, 1);
  assert.equal(warnings[0].actualSequence, 2);
  assert.equal(warnings[0].invocationId, 'inv-1');
  assert.equal(warnings[0].sourceMessageId, h.source.id);
  assert.deepEqual(warnings[0].interveningEvents, [
    { sourceEventId: 'inv:inv-1:hb:1500', kind: 'invocation.heartbeat', at: 1_500 },
  ]);
  assert.equal((await h.service.complete(auth(h), 'handled')).outcome, 'replayed');
  assert.equal(attempts, 2, 'replay must not attempt another append');
});

test('#1371 sustained contention remains a bounded failure with no terminal', async () => {
  let attempts = 0;
  const warnings = [];
  const h = await harness({
    log: { warn: (fields) => warnings.push(fields) },
    beforeDispositionRecord: async ({ ingest }) => {
      attempts += 1;
      await ingest.record(heartbeat(1_500 + attempts));
    },
  });

  await assert.rejects(h.service.complete(auth(h), 'handled'), { code: 'a2a_dispatch_disposition_fence_conflict' });

  assert.equal(attempts, 2, 'one callback may try the append at most twice');
  assert.equal((await dispositions(h)).length, 0);
  assert.equal((await h.projectionStore.get(SUBJECT)).state, 'active');
  assert.deepEqual(
    warnings.map(({ expectedSequence, actualSequence }) => [expectedSequence, actualSequence]),
    [
      [1, 2],
      [2, 3],
    ],
  );
});

test('#1371 a verified successor arriving during CAS returns its replacement pointer', async () => {
  let attempts = 0;
  let successor;
  const h = await harness({
    beforeDispositionRecord: async ({ ingest }) => {
      attempts += 1;
      successor = h.messageStore.append({
        userId: 'user-1',
        threadId: 'thread-1',
        catId: createCatId('codex-sol'),
        content: '@opus continue this exact source',
        mentions: [createCatId('opus')],
        replyTo: h.source.id,
        timestamp: 1_500,
      });
      await ingest.record(
        buildHandedEvent({
          threadId: 'thread-1',
          fromCatId: 'codex-sol',
          toCatId: 'opus',
          messageId: successor.id,
          at: 1_500,
        }),
      );
    },
  });

  await assert.rejects(h.service.complete(auth(h), 'completed'), (error) => {
    assert.equal(error.code, 'a2a_dispatch_disposition_replaced');
    assert.equal(error.replacement.sourceMessageId, successor.id);
    assert.equal(error.replacement.toCatId, 'opus');
    return true;
  });
  assert.equal(attempts, 1, 'fresh lineage validation rejects before a second append');
  assert.equal((await dispositions(h)).length, 0);
  assert.equal((await h.projectionStore.get(SUBJECT)).holder, 'opus');
});

test('#1371 a replaced invocation cannot use the contention retry', async () => {
  let attempts = 0;
  const h = await harness({
    beforeDispositionRecord: async ({ ingest }) => {
      attempts += 1;
      h.setLatest(false);
      await ingest.record(heartbeat(1_500));
    },
  });

  await assert.rejects(h.service.complete(auth(h), 'handled'), { code: 'a2a_dispatch_disposition_stale_invocation' });
  assert.equal(attempts, 1);
  assert.equal((await dispositions(h)).length, 0);
});

test('#1371 the retry re-resolves a source that became unavailable', async () => {
  let attempts = 0;
  const h = await harness({
    beforeDispositionRecord: async ({ ingest }) => {
      attempts += 1;
      h.messageStore.getById = async () => null;
      await ingest.record(heartbeat(1_500));
    },
  });

  await assert.rejects(h.service.complete(auth(h), 'handled'), { code: 'a2a_dispatch_disposition_source_mismatch' });
  assert.equal(attempts, 1);
  assert.equal((await dispositions(h)).length, 0);
});

test('#1371 conflict diagnostics bound event metadata and never include event payloads', async () => {
  let attempts = 0;
  const warnings = [];
  const h = await harness({
    log: { warn: (fields) => warnings.push(fields) },
    beforeDispositionRecord: async ({ ingest }) => {
      attempts += 1;
      if (attempts !== 1) return;
      for (let index = 0; index < 12; index += 1) await ingest.record(heartbeat(1_500 + index));
    },
  });

  assert.equal((await h.service.complete(auth(h), 'completed')).outcome, 'applied');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].actualSequence, 13);
  assert.equal(warnings[0].interveningEvents.length, 8);
  assert.equal(warnings[0].omittedEventCount, 4);
  assert.ok(warnings[0].interveningEvents.every((event) => !('payload' in event)));
});
