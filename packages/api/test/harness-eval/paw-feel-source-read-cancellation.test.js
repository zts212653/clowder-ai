import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { RedisPawFeelDispositionEventLog } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/event-log.js';
import { PawFeelDispositionReadModel } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/read-model.js';

function barrier() {
  let start;
  let release;
  const started = new Promise((resolve) => {
    start = resolve;
  });
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  return {
    started,
    release,
    read: () => {
      start();
      return pending;
    },
  };
}

function idFor(message, index = 0) {
  return `${message}:${index.toString(16).padStart(64, '0')}:0`;
}

function discovered(signalId) {
  return {
    eventId: `discovered:${signalId}`,
    signalId,
    type: 'discovered',
    actor: { kind: 'automation', id: 'collector' },
    occurredAt: '2026-10-03T00:00:00Z',
    source: {
      sourceMessageId: signalId.split(':')[0],
      sourceThreadId: 't',
      sourceCatId: 'codex-astra',
      markerDigest: signalId.split(':')[1],
      sameDigestOrdinal: 0,
      markerIndex: 0,
    },
    backfilled: false,
    captureMethod: 'legacy_parser',
    captureAssessment: 'confirmed',
  };
}

async function cancelWhileBlocked(model, blocked, releaseValue) {
  const controller = new AbortController();
  const reason = new Error('source-scoped HTTP client disconnected');
  let outcome;
  const pending = model.list({ sourceMessageId: 'source', signal: controller.signal }).then(
    (page) => {
      outcome = page;
    },
    (error) => {
      outcome = error;
    },
  );
  const reached = await Promise.race([blocked.started.then(() => true), pending.then(() => false)]);
  assert.equal(reached, true, JSON.stringify(outcome));
  controller.abort(reason);
  await setImmediate();
  try {
    assert.equal(outcome, reason, 'disconnect must reject before the blocked store read is released');
  } finally {
    blocked.release(typeof releaseValue === 'function' ? releaseValue() : releaseValue);
    await pending;
    await setImmediate();
  }
}

test('source-scoped cancellation covers the first signal-ID read', async () => {
  const blocked = barrier();
  let eventReads = 0;
  const model = new PawFeelDispositionReadModel({
    eventLog: {
      listSignalIdsBySourceMessageId: blocked.read,
      async readMany() {
        eventReads++;
        return new Map();
      },
    },
    messageStore: {
      async getById() {
        assert.fail('cancelled enumeration reached source messages');
      },
    },
  });
  await cancelWhileBlocked(model, blocked, []);
  assert.equal(eventReads, 0);
});

test('source-scoped cancellation stops Redis enumeration after its in-flight cursor page', async () => {
  const blocked = barrier();
  let scanCalls = 0;
  const eventLog = new RedisPawFeelDispositionEventLog({
    sscan() {
      scanCalls++;
      return scanCalls === 1 ? blocked.read() : Promise.resolve(['0', []]);
    },
  });
  const model = new PawFeelDispositionReadModel({
    eventLog,
    messageStore: {
      async getById() {
        return null;
      },
    },
  });
  await cancelWhileBlocked(model, blocked, ['17', []]);
  assert.equal(scanCalls, 1, 'a cancelled source request must not issue the next SSCAN');
});

test('source-scoped cancellation stops a multi-batch duplicate closure before its remaining dependencies', async () => {
  const blocked = barrier();
  const roots = Array.from({ length: 130 }, (_, i) => idFor('source', i));
  const calls = [];
  let messageReads = 0;
  const eventsFor = (id) => [
    discovered(id),
    {
      eventId: `duplicate:${id}`,
      signalId: id,
      type: 'duplicate',
      actor: { kind: 'cat', id: 'opus55' },
      occurredAt: '2026-10-03T00:01:00Z',
      duplicateOf: id.replace('source:', 'canonical:'),
      ownerCatId: 'opus55',
    },
  ];
  const model = new PawFeelDispositionReadModel({
    eventLog: {
      async listSignalIdsBySourceMessageId() {
        return roots;
      },
      readMany(ids) {
        calls.push([...ids]);
        if (calls.length === 4) return blocked.read();
        return Promise.resolve(
          new Map(ids.map((id) => [id, id.startsWith('source:') ? eventsFor(id) : [discovered(id)]])),
        );
      },
    },
    messageStore: {
      async getById() {
        messageReads++;
        return null;
      },
    },
  });
  await cancelWhileBlocked(model, blocked, () => new Map(calls[3].map((id) => [id, [discovered(id)]])));
  assert.equal(calls.length, 4, 'abort must not read the remaining duplicate dependency batches');
  assert.equal(calls[3].length, 50);
  assert.equal(messageReads, 0);
});

test('source-scoped cancellation covers source snapshots after event projection', async () => {
  const blocked = barrier();
  const model = new PawFeelDispositionReadModel({
    eventLog: {
      async listSignalIdsBySourceMessageId() {
        return [idFor('source')];
      },
      async readMany() {
        return new Map([[idFor('source'), [discovered(idFor('source'))]]]);
      },
    },
    messageStore: { getById: blocked.read },
  });
  await cancelWhileBlocked(model, blocked, null);
});
