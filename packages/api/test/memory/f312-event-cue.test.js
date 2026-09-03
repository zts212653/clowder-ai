import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EventCueResolver } from '../../dist/domains/memory/cue/resolvers/EventCueResolver.js';
import {
  EVENT_CUE_WINDOW_MS,
  EventMemoryCueSource,
} from '../../dist/domains/memory/cue/sources/EventMemoryCueSource.js';
import { EventMemoryStore } from '../../dist/domains/memory/EventMemoryStore.js';

const ownerUserId = 'owner-1';
const threadId = 'thread-1';
const scope = { ownerUserId, threadId, invocationId: 'invocation-1' };

function ownerMessage(id, subjectThreadId = threadId) {
  return {
    id,
    threadId: subjectThreadId,
    userId: ownerUserId,
    catId: null,
    content: 'Magic-word source',
    timestamp: 1_000_000,
  };
}

function event(overrides = {}) {
  return {
    eventId: 'evt_current',
    ownerUserId,
    type: '第一性原理',
    trigger: 'human_brake',
    cat: 'codex-sol',
    threadId,
    messageId: 'msg_current',
    timestamp: 1_000_000,
    summary: '第一性原理',
    cognitiveTransition: 'user_brake',
    relatedHarness: null,
    confidence: 'high',
    ...overrides,
  };
}

function record(overrides = {}) {
  const { eventId: _eventId, ownerUserId: _ownerUserId, ...input } = event(overrides);
  return input;
}

describe('F312 Event cue vertical slice', () => {
  it('selects only a high-confidence event in the exact owner, thread, and temporal window', async () => {
    const now = 1_000_000;
    const store = new EventMemoryStore(':memory:');
    await store.initialize();
    const current = store.markEvent(record(), ownerUserId).event;
    store.markEvent(
      record({
        threadId: 'thread-other',
        messageId: 'msg_other_thread',
        timestamp: now - 1,
      }),
      ownerUserId,
    );
    store.markEvent(
      record({
        messageId: 'msg_old',
        timestamp: now - EVENT_CUE_WINDOW_MS - 1,
      }),
      ownerUserId,
    );
    store.markEvent(
      record({
        messageId: 'msg_low',
        timestamp: now,
        confidence: 'low',
      }),
      ownerUserId,
    );

    const source = new EventMemoryCueSource({
      ownerUserId,
      eventStore: store,
      messageStore: { getById: (messageId) => ownerMessage(messageId) },
      episodeStore: { hasTerminalConsumptionForSource: () => false },
      now: () => now,
    });
    const seed = await source.prepareOpportunity({ ownerUserId, threadId, occurredAt: now });
    assert.equal(seed?.kind, 'recent_event_available');
    assert.equal(seed?.producer, 'event_memory');
    assert.equal(seed?.payload.eventId, current.eventId);
    assert.equal(seed?.payload.subjectThreadId, threadId);
    assert.match(seed?.payload.sourceRevision ?? '', /^sha256:/);

    assert.equal(
      await source.prepareOpportunity({ ownerUserId, threadId: 'thread-without-events', occurredAt: now }),
      null,
    );
    assert.equal(await source.prepareOpportunity({ ownerUserId: 'owner-2', threadId, occurredAt: now }), null);
  });

  it('resolves, drills, and suppresses one exact Event revision after a terminal receipt', async () => {
    const current = event();
    const messages = new Map([[current.messageId, ownerMessage(current.messageId)]]);
    const terminalRevisions = new Set();
    const source = new EventMemoryCueSource({
      ownerUserId,
      eventStore: {
        listEvents: () => (current ? [current] : []),
        getEvent: (eventId) => (current?.eventId === eventId ? current : null),
      },
      messageStore: { getById: (messageId) => messages.get(messageId) ?? null },
      episodeStore: {
        hasTerminalConsumptionForSource: (input) => terminalRevisions.has(input.sourceRevision),
      },
      now: () => 1_000_000,
    });
    const seed = await source.prepareOpportunity({ ownerUserId, threadId, occurredAt: 1_000_000 });
    const opportunity = {
      v: 1,
      opportunityId: 'event-opportunity-1',
      consumer: 'agent_route',
      scope,
      occurredAt: seed.occurredAt,
      ...seed,
    };
    const cues = await new EventCueResolver(source).resolve(opportunity, {
      now: 1_000_000,
      expiresAt: 1_300_000,
      createDrillHandle: ({ family }) => `opaque:${family}`,
    });
    assert.equal(cues.length, 1);
    assert.equal(cues[0].resolverFamily, 'event');
    assert.equal(cues[0].drill.family, 'event');
    assert.equal(cues[0].source.asOf, current.timestamp);

    const drilled = await source.read({
      ownerUserId,
      threadId,
      anchor: cues[0].source.anchor,
      expectedRevision: cues[0].source.revision,
    });
    assert.equal(drilled.status, 'ok');
    assert.equal(drilled.payload.eventId, current.eventId);
    assert.equal(drilled.payload.source.messageId, current.messageId);

    terminalRevisions.add(seed.payload.sourceRevision);
    assert.equal(await source.prepareOpportunity({ ownerUserId, threadId, occurredAt: 1_000_001 }), null);
  });

  it('expires and invalidates corrected, forgotten, or out-of-scope Event sources', async () => {
    let now = 1_000_000;
    let current = event();
    const messages = new Map([[current.messageId, ownerMessage(current.messageId)]]);
    const source = new EventMemoryCueSource({
      ownerUserId,
      eventStore: {
        listEvents: () => (current ? [current] : []),
        getEvent: (eventId) => (current?.eventId === eventId ? current : null),
      },
      messageStore: { getById: (messageId) => messages.get(messageId) ?? null },
      episodeStore: { hasTerminalConsumptionForSource: () => false },
      now: () => now,
    });
    const seed = await source.prepareOpportunity({ ownerUserId, threadId, occurredAt: now });
    const coordinate = {
      ownerUserId,
      threadId,
      anchor: `event-memory:${current.eventId}`,
      expectedRevision: seed.payload.sourceRevision,
    };

    current = { ...current, summary: 'corrected summary' };
    assert.deepEqual(await source.read(coordinate), {
      status: 'not_available',
      invalidationReason: 'source_corrected',
    });

    current = event();
    messages.delete(current.messageId);
    assert.deepEqual(await source.read(coordinate), {
      status: 'not_available',
      invalidationReason: 'source_forgotten',
    });

    messages.set(current.messageId, ownerMessage(current.messageId, 'thread-other'));
    assert.deepEqual(await source.read(coordinate), {
      status: 'not_available',
      invalidationReason: 'scope_revoked',
    });

    messages.set(current.messageId, ownerMessage(current.messageId));
    now = current.timestamp + EVENT_CUE_WINDOW_MS;
    assert.equal((await source.read(coordinate)).status, 'ok');
    now += 1;
    assert.deepEqual(await source.read(coordinate), {
      status: 'not_available',
      invalidationReason: 'expired',
    });
  });
});
