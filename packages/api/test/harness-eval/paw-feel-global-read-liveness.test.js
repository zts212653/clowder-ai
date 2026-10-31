import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { PawFeelDispositionReadModel } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/read-model.js';

test('global inbox bounds resolver fan-out, yields to health work, and keeps full counts and page membership', async () => {
  const events = new Map(
    Array.from({ length: 2000 }, (_, i) => [
      `source-${i}:${'a'.repeat(64)}:0`,
      [
        {
          eventId: `event-${i}`,
          signalId: `source-${i}:${'a'.repeat(64)}:0`,
          type: 'discovered',
          actor: { kind: 'automation', id: 'collector' },
          occurredAt: '2026-10-03T00:00:00.000Z',
          source: {
            sourceMessageId: `source-${i}`,
            sourceThreadId: 't',
            sourceCatId: 'codex-astra',
            markerDigest: 'a'.repeat(64),
            sameDigestOrdinal: 0,
            markerIndex: 0,
          },
          backfilled: false,
          captureMethod: 'legacy_parser',
          captureAssessment: 'confirmed',
        },
      ],
    ]),
  );
  let inFlight = 0;
  let peak = 0;
  let healthTicks = 0;
  const followUpResolver = {
    async resolve() {
      peak = Math.max(peak, ++inFlight);
      await setImmediate();
      inFlight--;
      return { resolution: 'open', ageMs: 1, continuation: { kind: 'untriaged', evidenceRefs: [] } };
    },
  };
  const model = new PawFeelDispositionReadModel({
    eventLog: {
      async listSignalIds() {
        return [...events.keys()];
      },
      async readMany(ids) {
        return new Map(ids.map((id) => [id, events.get(id)]));
      },
    },
    messageStore: {
      async getById() {
        return null;
      },
    },
    followUpResolver,
    now: () => '2026-10-03T01:00:00.000Z',
  });
  const health = setInterval(() => healthTicks++, 1);
  try {
    const first = await model.list({ limit: 10 });
    assert.equal(first.projectionStatus, 'available', first.unavailableReason);
    assert.equal(first.counts.total, 2000);
    assert.equal(first.items.length, 10);
    assert(first.nextCursor);
    assert(peak <= 16, `resolver fan-out was ${peak}`);
    assert(healthTicks > 0);
    const next = await model.list({ limit: 10, cursor: first.nextCursor });
    assert.equal(next.counts.total, first.counts.total);
    assert(
      !next.items.some((item) =>
        first.items.some((previous) => previous.disposition.signalId === item.disposition.signalId),
      ),
    );
  } finally {
    clearInterval(health);
  }
});
test('cancelled global owner resolution stops at the bounded batch and leaves no detached fan-out', async () => {
  let calls = 0;
  const controller = new AbortController();
  const projections = new Map(
    Array.from({ length: 1000 }, (_, i) => [
      `s-${i}`,
      {
        signalId: `s-${i}`,
        sourceMessageId: `m-${i}`,
        state: 'new',
        sequence: 1,
        discoveredAt: '2026-10-03T00:00:00Z',
        lastTransitionAt: '2026-10-03T00:00:00Z',
        sourceThreadId: 't',
        sourceCatId: 'codex-astra',
        markerDigest: 'a'.repeat(64),
        sameDigestOrdinal: 0,
      },
    ]),
  );
  const model = new PawFeelDispositionReadModel({
    eventLog: {
      async listSignalIds() {
        return [...projections.keys()];
      },
      async readProjections() {
        return projections;
      },
    },
    messageStore: {
      async getById() {
        return null;
      },
    },
    followUpResolver: {
      async resolve() {
        calls++;
        controller.abort(new Error('HTTP client left'));
        await setImmediate();
        return { resolution: 'open', ageMs: 1, continuation: { kind: 'untriaged', evidenceRefs: [] } };
      },
    },
  });
  await assert.rejects(model.list({ signal: controller.signal }), /HTTP client left/);
  assert(calls > 0 && calls <= 16, `cancelled resolver started ${calls} operations`);
  const settled = calls;
  await setImmediate();
  assert.equal(calls, settled);
});
test('client disconnect stops waiting on a slow shared source read without starting more work', async () => {
  let release;
  let started;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const slow = new Promise((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const projection = {
    signalId: 'slow',
    sourceMessageId: 'm',
    state: 'new',
    sequence: 1,
    discoveredAt: '2026-10-03T00:00:00Z',
    lastTransitionAt: '2026-10-03T00:00:00Z',
  };
  const model = new PawFeelDispositionReadModel({
    eventLog: {
      async listSignalIds() {
        return ['slow'];
      },
      async readProjections() {
        return new Map([['slow', projection]]);
      },
    },
    messageStore: {
      getById() {
        started();
        return slow;
      },
    },
  });
  let cancelled = false;
  const result = model.list({ signal: controller.signal }).catch(() => {
    cancelled = true;
  });
  await began;
  controller.abort(new Error('client disconnected'));
  await setImmediate();
  try {
    assert.equal(cancelled, true);
  } finally {
    release(null);
    await result;
  }
});

test('global cancellation also covers coverage and legacy event reads before source resolution', async () => {
  for (const stage of ['coverage', 'events']) {
    let release;
    let began;
    const started = new Promise((resolve) => {
      began = resolve;
    });
    const slow = new Promise((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();
    let reads = 0;
    const model = new PawFeelDispositionReadModel({
      ...(stage === 'coverage'
        ? {
            coverageStore: {
              read() {
                began();
                return slow;
              },
            },
          }
        : {}),
      eventLog: {
        async listSignalIds() {
          return Array.from({ length: 1000 }, (_, i) => `s-${i}`);
        },
        readMany() {
          reads++;
          began();
          return slow;
        },
      },
      messageStore: {
        async getById() {
          return null;
        },
      },
    });
    let cancelled = false;
    const pending = model.list({ signal: controller.signal }).catch(() => {
      cancelled = true;
    });
    await started;
    controller.abort(new Error('client left before projections'));
    await setImmediate();
    try {
      assert.equal(cancelled, true, `blocked during ${stage}`);
    } finally {
      release(stage === 'coverage' ? undefined : new Map());
      await pending;
    }
    assert(reads <= 1, `cancelled legacy reader continued ${reads} batches`);
  }
});
