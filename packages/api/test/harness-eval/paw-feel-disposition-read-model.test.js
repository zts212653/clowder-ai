import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspectPawFeelMessage } from '../../dist/infrastructure/harness-eval/friction/paw-feel-source.js';
import { PawFeelDispositionReadModel } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/read-model.js';

const HOUR = 3_600_000;
const NOW_MS = Date.parse('2026-07-26T12:00:00.000Z');
const NOW = new Date(NOW_MS).toISOString();

function message(index, ageHours = 1, content = `[爪感差: rg+phenomenon-${index}]`, extra = undefined) {
  return {
    id: `message-${String(index).padStart(3, '0')}`,
    threadId: 'thread-source',
    userId: 'user-1',
    catId: 'codex-sol',
    content,
    mentions: [],
    timestamp: NOW_MS - ageHours * HOUR,
    ...(extra ? { extra } : {}),
  };
}

function eventLogFixture(messages, transitions = new Map()) {
  const events = new Map();
  for (const source of messages) {
    const inspected = inspectPawFeelMessage(source);
    assert.equal(inspected.kind, 'canonical');
    for (const candidate of inspected.candidates) {
      const signalEvents = [
        {
          eventId: `discovered:${candidate.signalId}`,
          signalId: candidate.signalId,
          type: 'discovered',
          actor: { kind: 'automation', id: 'paw-feel-reconciler' },
          occurredAt: candidate.occurredAt,
          source: {
            sourceMessageId: candidate.sourceMessageId,
            sourceThreadId: candidate.sourceThreadId,
            sourceCatId: candidate.sourceCatId,
            markerDigest: candidate.markerDigest,
            sameDigestOrdinal: candidate.sameDigestOrdinal,
            markerIndex: candidate.markerIndex,
          },
          backfilled: false,
          captureMethod: source.id.endsWith('002') ? 'typed' : 'legacy_parser',
          captureAssessment: source.id.endsWith('002') ? 'confirmed' : 'ambiguous',
        },
        ...(transitions.get(source.id) ?? []),
      ];
      events.set(candidate.signalId, signalEvents);
    }
  }
  return {
    events,
    async listSignalIds() {
      return [...events.keys()].sort();
    },
    async listSignalIdsBySourceMessageId(sourceMessageId) {
      return [...events.keys()].filter((signalId) => signalId.startsWith(`${sourceMessageId}:`));
    },
    async read(signalId) {
      return events.get(signalId) ?? [];
    },
    async readMany(signalIds) {
      return new Map(signalIds.map((signalId) => [signalId, events.get(signalId) ?? []]));
    },
  };
}

function messageStoreFixture(messages) {
  const byId = new Map(messages.map((entry) => [entry.id, entry]));
  return {
    byId,
    async getById(id) {
      return byId.get(id) ?? null;
    },
  };
}

function seenAndClosed(source, actor = 'opus') {
  const inspected = inspectPawFeelMessage(source);
  assert.equal(inspected.kind, 'canonical');
  const signalId = inspected.candidates[0].signalId;
  return [
    {
      eventId: `seen:${signalId}`,
      signalId,
      type: 'seen',
      actor: { kind: 'cat', id: actor },
      occurredAt: new Date(source.timestamp + 1_000).toISOString(),
    },
    {
      eventId: `closed:${signalId}`,
      signalId,
      type: 'closed',
      actor: { kind: 'cat', id: actor },
      occurredAt: new Date(source.timestamp + 2_000).toISOString(),
      reasonCode: 'fixed',
      outcomeRef: 'commit:abc',
    },
  ];
}

describe('F278 paw-feel read model', () => {
  it('keeps every row visible in degraded mode and resolves previews from exact source messages', async () => {
    const messages = [message(1, 80), message(2, 2, '[爪感差: pnpm+test output too noisy]')];
    const readModel = new PawFeelDispositionReadModel({
      eventLog: eventLogFixture(messages),
      messageStore: messageStoreFixture(messages),
      semanticDegraded: () => true,
      now: () => NOW,
    });

    const page = await readModel.list();

    assert.equal(page.projectionStatus, 'available');
    assert.equal(page.degraded, true);
    assert.equal(page.items.length, 2);
    assert.equal(page.counts.total, 2);
    assert.equal(page.counts.unseen, 2);
    assert.equal(page.counts.overdue, 1);
    assert.equal(page.items[0].overdue, true);
    assert.equal(page.items[0].source.availability, 'available');
    assert.match(page.items[0].source.preview, /phenomenon-1/);
    assert.equal(page.items[0].deterministicGroupKey, 'tool:rg');
    assert.equal(page.items[1].deterministicGroupKey, 'tool:pnpm');
    assert.deepEqual(page.denominator, {
      reportOccurrences: 2,
      uniqueSourceMessages: 2,
      historicalBackfill: 0,
      postActivationIntake: 2,
      typedConfirmed: 1,
      ambiguousOrContaminated: 1,
      reviewBundles: 2,
      problemFamilies: {
        status: 'unavailable',
        reason: 'No authoritative grouping contract',
      },
    });
  });

  it('uses the source projection reader without full-message hydration and keeps canonical source context', async () => {
    const source = {
      ...message(1, 1, '[爪感差: hmget+source projection]'),
      timestamp: NOW_MS - 4 * HOUR,
      timelineOrderAt: NOW_MS - 3 * HOUR,
      extra: { stream: { turnInvocationId: 'turn-source', invocationId: 'legacy-source' } },
    };
    let fullReads = 0;
    let requestedIds = [];
    const readModel = new PawFeelDispositionReadModel({
      eventLog: eventLogFixture([source]),
      messageStore: {
        async getById() {
          fullReads += 1;
          throw new Error('full message hydration must not service paw-feel source reads');
        },
        async getPawFeelSourceProjections(ids) {
          requestedIds = [...ids];
          return new Map([
            [
              source.id,
              {
                kind: 'available',
                message: {
                  id: source.id,
                  threadId: source.threadId,
                  userId: source.userId,
                  catId: source.catId,
                  content: source.content,
                  timestamp: source.timestamp,
                  timelineOrderAt: source.timelineOrderAt,
                  extra: source.extra,
                },
              },
            ],
          ]);
        },
      },
      now: () => NOW,
    });

    const page = await readModel.list({ limit: 1 });

    assert.deepEqual(requestedIds, [source.id]);
    assert.equal(fullReads, 0);
    assert.equal(page.projectionStatus, 'available');
    assert.equal(page.counts.total, 1);
    assert.equal(page.denominator.reportOccurrences, 1);
    assert.equal(page.bundles.length, 1);
    assert.equal(page.items[0].source.availability, 'available');
    assert.equal(page.items[0].sourceOccurredAt, new Date(source.timelineOrderAt).toISOString());
    assert.equal(page.items[0].reviewContext?.turnInvocationId, 'turn-source');
    await readModel.assertBundleSnapshot(
      page.bundles[0].bundleKey,
      page.bundles[0].members.map((item) => ({
        signalId: item.disposition.signalId,
        expectedSequence: item.disposition.sequence,
      })),
      page.bundles[0].membershipToken,
    );
  });

  it('keeps the legacy delivery order when a source projection has no timeline score', async () => {
    const source = {
      ...message(1, 1, '[爪感差: legacy delivery ordering]'),
      timestamp: NOW_MS - 4 * HOUR,
      deliveredAt: NOW_MS - 2 * HOUR,
      deliveryStatus: 'delivered',
    };
    const readModel = new PawFeelDispositionReadModel({
      eventLog: eventLogFixture([source]),
      messageStore: {
        async getById() {
          throw new Error('full message hydration must not service paw-feel source reads');
        },
        async getPawFeelSourceProjections() {
          return new Map([
            [
              source.id,
              {
                kind: 'available',
                message: {
                  id: source.id,
                  threadId: source.threadId,
                  userId: source.userId,
                  catId: source.catId,
                  content: source.content,
                  timestamp: source.timestamp,
                  deliveredAt: source.deliveredAt,
                  deliveryStatus: source.deliveryStatus,
                },
              },
            ],
          ]);
        },
      },
      now: () => NOW,
    });

    const page = await readModel.list({ limit: 1 });

    assert.equal(page.items[0].sourceOccurredAt, new Date(source.deliveredAt).toISOString());
  });

  it('keeps a ledger row unavailable when the source projection reader reports a failed read', async () => {
    const source = message(1);
    const readModel = new PawFeelDispositionReadModel({
      eventLog: eventLogFixture([source]),
      messageStore: {
        async getById() {
          return source;
        },
        async getPawFeelSourceProjections() {
          return new Map([[source.id, { kind: 'unavailable', reason: 'read_failed' }]]);
        },
      },
      now: () => NOW,
    });

    const page = await readModel.list();

    assert.equal(page.projectionStatus, 'available');
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].source.availability, 'unavailable');
    assert.equal(page.items[0].source.reason, 'source read failed');
  });

  it('rejects a cross-post copy returned by the source projection reader', async () => {
    const source = message(1);
    const readModel = new PawFeelDispositionReadModel({
      eventLog: eventLogFixture([source]),
      messageStore: {
        async getById() {
          return source;
        },
        async getPawFeelSourceProjections() {
          return new Map([
            [
              source.id,
              {
                kind: 'available',
                message: {
                  ...source,
                  extra: { crossPost: { sourceThreadId: 'thread-origin' } },
                },
              },
            ],
          ]);
        },
      },
      now: () => NOW,
    });

    const page = await readModel.list();

    assert.equal(page.projectionStatus, 'available');
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].source.availability, 'unavailable');
    assert.equal(page.items[0].source.reason, 'source digest mismatch');
  });

  it('fails loud per row when the original message is missing or its digest no longer matches', async () => {
    const missing = message(1);
    const changed = message(2);
    const store = messageStoreFixture([missing, changed]);
    store.byId.delete(missing.id);
    store.byId.set(changed.id, { ...changed, content: '[爪感差: rg+different body]' });
    const readModel = new PawFeelDispositionReadModel({
      eventLog: eventLogFixture([missing, changed]),
      messageStore: store,
      now: () => NOW,
    });

    const page = await readModel.list();
    const reasons = page.items.map((entry) => entry.source.reason);

    assert.equal(page.projectionStatus, 'available');
    assert.deepEqual(reasons.sort(), ['source digest mismatch', 'source message unavailable']);
    assert.equal(page.items.length, 2, 'source failure must not hide ledger rows');
  });

  it('keeps every ledger row visible when one source read throws', async () => {
    const failing = message(1);
    const healthy = message(2);
    const store = messageStoreFixture([failing, healthy]);
    const getById = store.getById.bind(store);
    store.getById = async (id) => {
      if (id === failing.id) throw new Error('message store timeout');
      return getById(id);
    };
    const readModel = new PawFeelDispositionReadModel({
      eventLog: eventLogFixture([failing, healthy]),
      messageStore: store,
      now: () => NOW,
    });

    const page = await readModel.list();
    const failingItem = page.items.find((entry) => entry.disposition.sourceMessageId === failing.id);
    const healthyItem = page.items.find((entry) => entry.disposition.sourceMessageId === healthy.id);

    assert.equal(page.projectionStatus, 'available');
    assert.equal(page.items.length, 2, 'one source exception must not hide any ledger row');
    assert.equal(page.counts.total, 2);
    assert.equal(failingItem?.source.availability, 'unavailable');
    assert.equal(failingItem?.source.reason, 'source read failed');
    assert.equal(healthyItem?.source.availability, 'available');
  });

  it('keeps exact-source ledger rows visible across missing, read-error, and digest-drift sources', async () => {
    const source = message(1);
    const fixtures = [
      {
        name: 'missing',
        reason: 'source message unavailable',
        configure(store) {
          store.byId.delete(source.id);
        },
      },
      {
        name: 'read error',
        reason: 'source read failed',
        configure(store) {
          store.getById = async () => {
            throw new Error('message store timeout');
          };
        },
      },
      {
        name: 'digest drift',
        reason: 'source digest mismatch',
        configure(store) {
          store.byId.set(source.id, { ...source, content: '[爪感差: rg+changed body]' });
        },
      },
    ];

    for (const fixture of fixtures) {
      const store = messageStoreFixture([source]);
      fixture.configure(store);
      const readModel = new PawFeelDispositionReadModel({
        eventLog: eventLogFixture([source]),
        messageStore: store,
        now: () => NOW,
      });

      const page = await readModel.list({ sourceMessageId: source.id });

      assert.equal(page.projectionStatus, 'available', fixture.name);
      assert.equal(page.items.length, 1, fixture.name);
      assert.equal(page.items[0].source.availability, 'unavailable', fixture.name);
      assert.equal(page.items[0].source.reason, fixture.reason, fixture.name);
    }
  });

  it('paginates 50 at a time while counts and duty summaries remain complete', async () => {
    const messages = Array.from({ length: 55 }, (_, index) => message(index, 55 - index));
    const transitions = new Map([[messages[54].id, seenAndClosed(messages[54])]]);
    const readModel = new PawFeelDispositionReadModel({
      eventLog: eventLogFixture(messages, transitions),
      messageStore: messageStoreFixture(messages),
      now: () => NOW,
    });

    const first = await readModel.list({ limit: 50 });
    const second = await readModel.list({ limit: 50, cursor: first.nextCursor });
    const duty = await readModel.listUndispositioned();

    assert.equal(first.items.length, 50);
    assert.equal(first.counts.total, 55);
    assert.equal(first.counts.disposed, 1);
    assert.ok(first.nextCursor);
    assert.equal(second.items.length, 5);
    assert.equal(second.nextCursor, undefined);
    assert.equal(new Set([...first.items, ...second.items].map((entry) => entry.disposition.signalId)).size, 55);
    assert.equal(duty.length, 54);
  });

  it('shows newest undispositioned reports first when requested and keeps cursor pagination stable', async () => {
    const messages = Array.from({ length: 55 }, (_, index) => message(index, 55 - index));
    const readModel = new PawFeelDispositionReadModel({
      eventLog: eventLogFixture(messages),
      messageStore: messageStoreFixture(messages),
      now: () => NOW,
    });

    const first = await readModel.list({ limit: 50, sort: 'newest' });
    const second = await readModel.list({ limit: 50, sort: 'newest', cursor: first.nextCursor });

    assert.equal(first.items[0].disposition.sourceMessageId, messages[54].id);
    assert.equal(first.items[49].disposition.sourceMessageId, messages[5].id);
    assert.equal(second.items[0].disposition.sourceMessageId, messages[4].id);
    assert.equal(new Set([...first.items, ...second.items].map((entry) => entry.disposition.signalId)).size, 55);
  });

  it('keeps original occurrence time distinct from backfill discovery and SLA age', async () => {
    const source = message(1, 1);
    const eventLog = eventLogFixture([source]);
    const [events] = eventLog.events.values();
    events[0] = {
      ...events[0],
      occurredAt: new Date(NOW_MS - 12 * HOUR).toISOString(),
      backfilled: true,
    };
    const readModel = new PawFeelDispositionReadModel({
      eventLog,
      messageStore: messageStoreFixture([source]),
      now: () => NOW,
    });

    const page = await readModel.list();

    assert.equal(page.items[0].sourceOccurredAt, new Date(source.timestamp).toISOString());
    assert.equal(page.items[0].disposition.backfilled, true);
    assert.equal(page.items[0].ageMs, 12 * HOUR);
    assert.equal(page.denominator.historicalBackfill, 1);
    assert.equal(page.denominator.postActivationIntake, 0);
  });

  it('derives coverage lag and filters by source/state without semantic ranking', async () => {
    const first = message(1, 40);
    const second = message(2, 1);
    const transitions = new Map([[second.id, seenAndClosed(second)]]);
    const readModel = new PawFeelDispositionReadModel({
      eventLog: eventLogFixture([first, second], transitions),
      messageStore: messageStoreFixture([first, second]),
      coverageStore: {
        async read() {
          return {
            coverageStartAt: new Date(NOW_MS - 7 * 24 * HOUR).toISOString(),
            lastSeenTimelineAt: new Date(NOW_MS - HOUR).toISOString(),
            status: 'healthy',
          };
        },
      },
      now: () => NOW,
    });

    const page = await readModel.list({ states: ['closed'], sourceCatId: 'codex-sol' });

    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].disposition.state, 'closed');
    assert.equal(page.coverage.status, 'lagging');
    assert.equal(page.coverage.lagMs, HOUR);
  });

  it('follows only the exact duplicate dependency graph for a source projection', async () => {
    const canonical = message(1, 3);
    const duplicate = message(2, 2);
    const unrelated = message(3, 1);
    const eventLog = eventLogFixture([canonical, duplicate, unrelated]);
    const canonicalInspection = inspectPawFeelMessage(canonical);
    const duplicateInspection = inspectPawFeelMessage(duplicate);
    assert.equal(canonicalInspection.kind, 'canonical');
    assert.equal(duplicateInspection.kind, 'canonical');
    const canonicalSignalId = canonicalInspection.candidates[0].signalId;
    const duplicateSignalId = duplicateInspection.candidates[0].signalId;
    eventLog.events.get(canonicalSignalId).push({
      eventId: `no-action:${canonicalSignalId}`,
      signalId: canonicalSignalId,
      type: 'no_action',
      actor: { kind: 'cat', id: 'opus' },
      occurredAt: NOW,
      reasonCode: 'not_actionable',
      ownerCatId: 'opus',
    });
    eventLog.events.get(duplicateSignalId).push({
      eventId: `duplicate:${duplicateSignalId}`,
      signalId: duplicateSignalId,
      type: 'duplicate',
      actor: { kind: 'cat', id: 'opus' },
      occurredAt: NOW,
      duplicateOf: canonicalSignalId,
      ownerCatId: 'opus',
    });
    const store = messageStoreFixture([canonical, duplicate, unrelated]);
    const sourceReads = [];
    const readModel = new PawFeelDispositionReadModel({
      eventLog,
      messageStore: {
        async getById(messageId) {
          sourceReads.push(messageId);
          return store.getById(messageId);
        },
      },
      now: () => NOW,
    });

    const page = await readModel.list({ sourceMessageId: duplicate.id });

    assert.equal(page.items.length, 1);
    assert.equal(page.counts.total, 1);
    assert.equal(page.items[0].issue.resolution, 'resolved');
    assert.equal(page.items[0].issue.continuation.kind, 'no_action');
    assert.equal(page.items[0].issue.continuation.canonicalSignalId, canonicalSignalId);
    assert.deepEqual(sourceReads, [duplicate.id, canonical.id]);
  });

  it('returns an unavailable projection instead of an empty-success lie when the ledger fails', async () => {
    const readModel = new PawFeelDispositionReadModel({
      eventLog: {
        async listSignalIds() {
          throw new Error('redis unavailable');
        },
        async read() {
          return [];
        },
      },
      messageStore: { async getById() {} },
      semanticDegraded: () => {
        throw new Error('embedding unavailable');
      },
      now: () => NOW,
    });

    const page = await readModel.list();

    assert.equal(page.projectionStatus, 'unavailable');
    assert.equal(page.degraded, true);
    assert.match(page.unavailableReason, /redis unavailable/);
    assert.equal(page.items.length, 0);
  });

  it('fails loud when exact-source membership points at a missing event log', async () => {
    const source = message(1);
    const inspection = inspectPawFeelMessage(source);
    assert.equal(inspection.kind, 'canonical');
    const signalId = inspection.candidates[0].signalId;
    const eventLog = {
      async listSignalIds() {
        return [signalId];
      },
      async listSignalIdsBySourceMessageId(sourceMessageId) {
        return sourceMessageId === source.id ? [signalId] : [];
      },
      async read() {
        return [];
      },
      async readMany(signalIds) {
        return new Map(signalIds.map((id) => [id, []]));
      },
    };
    const readModel = new PawFeelDispositionReadModel({
      eventLog,
      messageStore: messageStoreFixture([source]),
      now: () => NOW,
    });

    const globalPage = await readModel.list();
    const sourcePage = await readModel.list({ sourceMessageId: source.id });

    assert.equal(globalPage.projectionStatus, 'unavailable');
    assert.equal(sourcePage.projectionStatus, 'unavailable');
    assert.equal(sourcePage.unavailableReason, globalPage.unavailableReason);
    assert.match(sourcePage.unavailableReason, new RegExp(`signal ${signalId} has no durable events`));
  });

  it('partitions every row into one deterministic message, turn, legacy invocation, or safe signal bundle', async () => {
    const multiMarker = message(1, 8, '[爪感差: rg+first]\n[爪感差: pnpm+second]\n[爪感差: git+third]', {
      stream: { turnInvocationId: 'turn-shared', invocationId: 'parent-ignored' },
    });
    const turnA = message(2, 7, undefined, {
      stream: { turnInvocationId: 'turn-pair', invocationId: 'parent-pair' },
    });
    const turnB = message(3, 6, undefined, {
      stream: { turnInvocationId: 'turn-pair', invocationId: 'parent-pair' },
    });
    const legacyA = message(4, 5, undefined, { stream: { invocationId: 'legacy-pair' } });
    const legacyB = message(5, 4, undefined, { stream: { invocationId: 'legacy-pair' } });
    const missingA = message(6, 3);
    const missingB = message(7, 2);
    const messages = [multiMarker, turnA, turnB, legacyA, legacyB, missingA, missingB];
    const store = messageStoreFixture(messages);
    store.byId.delete(missingA.id);
    store.byId.delete(missingB.id);
    const readModel = new PawFeelDispositionReadModel({
      eventLog: eventLogFixture(messages),
      messageStore: store,
      now: () => NOW,
    });

    const page = await readModel.list({ limit: 50 });
    const allMemberIds = page.bundles.flatMap((bundle) => bundle.members.map((member) => member.disposition.signalId));

    assert.equal(page.items.length, 9);
    assert.equal(page.bundles.length, 5);
    assert.deepEqual(
      page.bundles.map(({ bundleKey, basis, rawSignalCount }) => ({ bundleKey, basis, rawSignalCount })),
      [
        { bundleKey: `message:${multiMarker.id}`, basis: 'message', rawSignalCount: 3 },
        { bundleKey: 'turn:turn-pair', basis: 'turn_invocation', rawSignalCount: 2 },
        { bundleKey: 'legacy-invocation:legacy-pair', basis: 'legacy_invocation', rawSignalCount: 2 },
        {
          bundleKey: `signal:${allMemberIds.find((signalId) => signalId.startsWith(`${missingA.id}:`))}`,
          basis: 'single_signal',
          rawSignalCount: 1,
        },
        {
          bundleKey: `signal:${allMemberIds.find((signalId) => signalId.startsWith(`${missingB.id}:`))}`,
          basis: 'single_signal',
          rawSignalCount: 1,
        },
      ],
    );
    assert.equal(new Set(allMemberIds).size, page.items.length);
    assert.deepEqual(new Set(allMemberIds), new Set(page.items.map((item) => item.disposition.signalId)));
    assert.equal(
      page.bundles.reduce((sum, bundle) => sum + bundle.rawSignalCount, 0),
      page.denominator.reportOccurrences,
    );
    assert.equal(page.bundleCounts.total, 5);
    assert.deepEqual(page.bundleCounts.byBasis, {
      message: 1,
      turn_invocation: 1,
      legacy_invocation: 1,
      single_signal: 2,
    });
    assert.equal(page.denominator.reviewBundles, 5);
    assert.equal(page.denominator.problemFamilies.status, 'unavailable');
  });

  it('never splits one bundle across cursor pages', async () => {
    const bundled = message(1, 3, Array.from({ length: 3 }, (_, index) => `[爪感差: rg+bundle-${index}]`).join('\n'));
    const single = message(2, 2);
    const messages = [bundled, single];
    const readModel = new PawFeelDispositionReadModel({
      eventLog: eventLogFixture(messages),
      messageStore: messageStoreFixture(messages),
      now: () => NOW,
    });

    const first = await readModel.list({ limit: 1 });
    const second = await readModel.list({ limit: 1, cursor: first.nextCursor });

    assert.equal(first.bundles.length, 1);
    assert.equal(first.items.length, 3);
    assert.equal(first.bundles[0].rawSignalCount, 3);
    assert.ok(first.nextCursor);
    assert.equal(second.bundles.length, 1);
    assert.equal(second.items.length, 1);
    assert.equal(new Set([...first.items, ...second.items].map((item) => item.disposition.signalId)).size, 4);
  });

  it('keeps message precedence stable when a state filter leaves one visible member', async () => {
    const multi = message(1, 3, '[爪感差: rg+first state]\n[爪感差: pnpm+second state]', {
      stream: { turnInvocationId: 'turn-shared' },
    });
    const other = message(2, 2, undefined, { stream: { turnInvocationId: 'turn-shared' } });
    const eventLog = eventLogFixture([multi, other]);
    const inspected = inspectPawFeelMessage(multi);
    assert.equal(inspected.kind, 'canonical');
    const firstSignal = inspected.candidates[0].signalId;
    eventLog.events.get(firstSignal).push({
      eventId: `no-action:${firstSignal}`,
      signalId: firstSignal,
      type: 'no_action',
      actor: { kind: 'cat', id: 'opus' },
      occurredAt: NOW,
      reasonCode: 'not_actionable',
      ownerCatId: 'opus',
    });
    const readModel = new PawFeelDispositionReadModel({
      eventLog,
      messageStore: messageStoreFixture([multi, other]),
      now: () => NOW,
    });

    const page = await readModel.list({ states: ['no_action'] });

    assert.equal(page.bundles.length, 1);
    assert.equal(page.bundles[0].bundleKey, `message:${multi.id}`);
    assert.equal(page.bundles[0].basis, 'message');
    assert.equal(page.bundles[0].rawSignalCount, 1);
  });
});
