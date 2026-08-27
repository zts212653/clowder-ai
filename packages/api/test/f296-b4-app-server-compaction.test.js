// F296 B4b — authoritative compaction on the Codex app-server.
//
// Gate 0 (2026-08-20, codex-cli 0.147.0) proved dynamically that:
//   * `thread/compact/start` is a real client request that the probe found by
//     asking the server, and its behaviour is proven by actually calling it.
//     (An earlier note here claimed it was absent from
//     `generate-json-schema`'s ClientRequest — that was WRONG, caused by a grep
//     pattern that could not match a second slash. It is a first-class variant.
//     Retracted in docs/features/evidence/F296/gate0-app-server-dynamic-probe.md;)
//   * the `contextCompaction` thread item carries only `{ id, type }`, so the
//     binding coordinates come from the enclosing `item/*` envelope;
//   * `thread/compacted` / ContextCompactedNotification is deprecated upstream.
// See docs/features/evidence/F296/gate0-app-server-dynamic-probe.md
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapCodexAppServerCompactionObservation } from '../dist/domains/cats/services/agents/providers/CodexAppServerEventMapper.js';
import { resolveAuthoritativeCompactionSupport } from '../dist/domains/cats/services/session/authoritative-compaction.js';

function capability(provider, carrier, observesCompression = false) {
  return {
    provider,
    carrier,
    reportsRuntimeWindow: false,
    authoritativeUsage: false,
    usageTelemetry: 'unavailable',
    nativeWindowControl: false,
    nativeCompressionControl: false,
    observesCompression,
    reason: 'test',
  };
}

function itemEnvelope(overrides = {}) {
  return {
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-7',
      item: { id: 'item-3', type: 'contextCompaction' },
      ...overrides,
    },
  };
}

test('a real compaction item maps to a stable coordinate taken from its envelope', () => {
  const observation = mapCodexAppServerCompactionObservation(itemEnvelope());
  assert.deepEqual(observation, {
    eventId: 'context-compaction:codex:app_server:thread-1:turn-7:item-3',
    runtimeSessionId: 'thread-1',
    evidenceRef: 'codex_app_server_context_compaction:thread-1:turn-7:item-3',
  });
});

test('the same compaction observed twice yields one identical event id', () => {
  // Replay suppression relies on identity, so item/started and item/completed
  // for the same item must not look like two compactions.
  const started = mapCodexAppServerCompactionObservation(itemEnvelope());
  const completed = mapCodexAppServerCompactionObservation({
    ...itemEnvelope(),
    method: 'item/completed',
  });
  assert.equal(started.eventId, completed.eventId);
});

test('a compaction missing any binding coordinate is refused rather than guessed', () => {
  for (const broken of [
    { threadId: undefined },
    { turnId: undefined },
    { item: { type: 'contextCompaction' } },
    { threadId: '' },
    { turnId: '' },
  ]) {
    assert.equal(
      mapCodexAppServerCompactionObservation(itemEnvelope(broken)),
      null,
      `must fail closed for ${JSON.stringify(broken)}`,
    );
  }
});

test('non-compaction items and the deprecated notification are not compactions', () => {
  assert.equal(mapCodexAppServerCompactionObservation(itemEnvelope({ item: { id: 'i', type: 'agentMessage' } })), null);
  assert.equal(
    mapCodexAppServerCompactionObservation({
      method: 'thread/compacted',
      params: { threadId: 'thread-1', turnId: 'turn-7' },
    }),
    null,
    'the deprecated notification must not be accepted as authoritative',
  );
  assert.equal(mapCodexAppServerCompactionObservation({ method: 'turn/completed', params: {} }), null);
});

test('the app-server compaction source is bound to the app-server carrier', () => {
  assert.deepEqual(
    resolveAuthoritativeCompactionSupport({
      capability: capability('openai', 'app_server', true),
      eventSource: 'codex_app_server_context_compaction',
    }),
    { status: 'supported', eventSource: 'codex_app_server_context_compaction' },
  );
});

test('no other carrier can borrow the app-server proof, whatever it declares', () => {
  for (const [provider, carrier] of [
    ['openai', 'exec_json'],
    ['anthropic', 'print_sdk'],
    ['anthropic', 'bg'],
    ['google', 'gemini_cli'],
    ['kimi', 'stream_json'],
  ]) {
    const support = resolveAuthoritativeCompactionSupport({
      // observesCompression=true on purpose: a declaration is not a route.
      capability: capability(provider, carrier, true),
      eventSource: 'codex_app_server_context_compaction',
    });
    assert.equal(support.status, 'unsupported', `${provider}/${carrier} must stay unsupported`);
    assert.equal(support.reason, 'typed_event_unroutable');
  }
});

test('Claude compaction support remains available when every hook proof is present', () => {
  assert.equal(
    resolveAuthoritativeCompactionSupport({
      capability: capability('anthropic', 'print_sdk', true),
      eventSource: 'claude_compact_boundary',
      hookAuthenticationReady: true,
      hookCarrierReady: true,
      hookInvocationAttested: true,
    }).status,
    'supported',
  );
  assert.equal(
    resolveAuthoritativeCompactionSupport({
      capability: capability('anthropic', 'bg', true),
      eventSource: 'claude_precompact_hook',
    }).reason,
    'carrier_event_delivery_unproven',
  );
});

// --- kimi exact-HEAD review, A4 ----------------------------------------------
// The pre-turn drain only covers the gap *between* turns. A compaction that
// arrives during a turn (auto-compact) was previously consumed as an ordinary
// item, so the epoch never advanced and the next projection stayed hot when it
// had to be cold — precisely the failure F296 exists to prevent.

test('a mid-turn compaction on the bound runtime is emitted as a typed event', async () => {
  const { CodexAppServerClient } = await import(
    '../dist/domains/cats/services/agents/providers/CodexAppServerClient.js'
  );

  class Inbox {
    #values = [];
    #waiters = [];
    #closed = false;
    push(v) {
      const w = this.#waiters.shift();
      if (w) w.resolve({ value: v, done: false });
      else this.#values.push(v);
    }
    close() {
      this.#closed = true;
      for (const w of this.#waiters.splice(0)) w.resolve({ value: undefined, done: true });
    }
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          const v = this.#values.shift();
          if (v !== undefined) return Promise.resolve({ value: v, done: false });
          if (this.#closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => this.#waiters.push({ resolve }));
        },
      };
    }
  }

  const inbox = new Inbox();
  const wire = {
    read: () => inbox,
    write: async (m) => {
      if (m.method === 'initialize') inbox.push({ id: m.id, result: {} });
      if (m.method === 'thread/start') inbox.push({ id: m.id, result: { thread: { id: 'thread-1' } } });
      if (m.method === 'turn/start') {
        inbox.push({ id: m.id, result: { turn: { id: 'turn-7', status: 'inProgress' } } });
        // compaction arrives DURING the turn, on the bound runtime
        inbox.push({
          method: 'item/started',
          params: { threadId: 'thread-1', turnId: 'turn-7', item: { id: 'item-3', type: 'contextCompaction' } },
        });
        // ...and one for a different runtime, which must be ignored
        inbox.push({
          method: 'item/started',
          params: { threadId: 'other-thread', turnId: 'turn-9', item: { id: 'item-4', type: 'contextCompaction' } },
        });
        inbox.push({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 'turn-7', status: 'completed' } },
        });
      }
    },
    terminate: async () => inbox.close(),
    close: async () => inbox.close(),
  };

  const events = [];
  for await (const e of new CodexAppServerClient({ wire }).run({
    prompt: { kind: 'frozen', prompt: 'work' },
    thread: { kind: 'start' },
  })) {
    events.push(e);
  }

  const compactions = events.filter((e) => e?.type === 'app_server.context_compaction');
  assert.equal(compactions.length, 1, 'exactly the bound runtime compaction is emitted');
  assert.deepEqual(compactions[0].observation, {
    eventId: 'context-compaction:codex:app_server:thread-1:turn-7:item-3',
    runtimeSessionId: 'thread-1',
    evidenceRef: 'codex_app_server_context_compaction:thread-1:turn-7:item-3',
  });
});

// --- kimi exact-HEAD review, round 2 P1 --------------------------------------
// Routing a compaction to the epoch owner is worthless if the very next
// resolve() overwrites the cold it committed. The `resumed` row used to return
// `hot` unconditionally, so both the pre-turn drain and the mid-turn route were
// silently nullified and the next prompt was built as an unseen delta on top of
// a runtime whose working memory had just been rewritten.
//
// This is the end-to-end assertion the earlier tests were missing: they proved
// the mechanism was reached, not that its effect survived to the projection.

test('a compaction cold survives into the next projection, and is consumed exactly once', async () => {
  const { ContextEpochOwner } = await import('../dist/domains/cats/services/session/ContextEpochOwner.js');
  const { InMemoryContextEpochStore } = await import('../dist/domains/cats/services/stores/ports/ContextEpochStore.js');

  const owner = new ContextEpochOwner(new InMemoryContextEpochStore());
  const scope = { userId: 'u1', catId: 'codex', threadId: 't1' };
  const RUNTIME = 'thread-1';
  const resumed = (ref) => ({
    ...scope,
    disposition: { state: 'resumed', reason: 'resume_confirmed', evidenceRef: ref, runtimeSessionId: RUNTIME },
  });

  const first = await owner.resolve({
    ...scope,
    disposition: { state: 'fresh', reason: 'no_prior_session', evidenceRef: 'e1', runtimeSessionId: RUNTIME },
  });
  assert.equal(first.contextMode, 'cold', 'a new scope starts cold');

  await owner.confirmColdConsumed({ ...scope, contextEpoch: first.contextEpoch });
  const hot = await owner.resolve(resumed('e2'));
  assert.equal(hot.contextMode, 'hot', 'an ordinary resume after a DELIVERED cold is hot');

  const compacted = await owner.observeCompaction({
    ...scope,
    event: { eventId: 'c1', runtimeSessionId: RUNTIME, evidenceRef: 'r1' },
  });
  assert.equal(compacted.contextEpoch, 2);
  assert.equal(compacted.contextMode, 'cold');

  const afterCompaction = await owner.resolve(resumed('e3'));
  assert.equal(
    afterCompaction.contextMode,
    'cold',
    'the projection after a compaction MUST be cold — otherwise the prompt is an unseen delta ' +
      'onto a runtime whose memory was just rewritten',
  );
  assert.equal(afterCompaction.contextEpoch, 2, 'resolving a cold must not advance the epoch');

  // Sol review: resolving is only an intent to build. Until a provider actually
  // accepted the generation, the cold must survive another resolve.
  const stillColdBeforeDelivery = await owner.resolve(resumed('e4'));
  assert.equal(
    stillColdBeforeDelivery.contextMode,
    'cold',
    'a resolve that never reached a provider must not consume the cold',
  );

  await owner.confirmColdConsumed({ ...scope, contextEpoch: 2 });
  const backToHot = await owner.resolve(resumed('e5'));
  assert.equal(backToHot.contextMode, 'hot', 'once delivered, the cold is consumed exactly once');
});

test('a superseded generation cannot consume a newer cold', async () => {
  const { ContextEpochOwner } = await import('../dist/domains/cats/services/session/ContextEpochOwner.js');
  const { InMemoryContextEpochStore } = await import('../dist/domains/cats/services/stores/ports/ContextEpochStore.js');

  const owner = new ContextEpochOwner(new InMemoryContextEpochStore());
  const scope = { userId: 'u1', catId: 'codex', threadId: 't-late' };
  const RUNTIME = 'thread-1';

  await owner.resolve({
    ...scope,
    disposition: { state: 'fresh', reason: 'no_prior_session', evidenceRef: 'e1', runtimeSessionId: RUNTIME },
  });
  await owner.observeCompaction({ ...scope, event: { eventId: 'c1', runtimeSessionId: RUNTIME, evidenceRef: 'r1' } });

  // A confirmation arriving late, stamped with the OLD epoch, must not consume
  // the cold that the compaction just created at the new epoch.
  await owner.confirmColdConsumed({ ...scope, contextEpoch: 1 });

  const next = await owner.resolve({
    ...scope,
    disposition: { state: 'resumed', reason: 'resume_confirmed', evidenceRef: 'e2', runtimeSessionId: RUNTIME },
  });
  assert.equal(next.contextMode, 'cold', 'a stale confirmation must not swallow the new cold');
});

test('a replayed compaction does not re-arm the cold', async () => {
  const { ContextEpochOwner } = await import('../dist/domains/cats/services/session/ContextEpochOwner.js');
  const { InMemoryContextEpochStore } = await import('../dist/domains/cats/services/stores/ports/ContextEpochStore.js');

  const owner = new ContextEpochOwner(new InMemoryContextEpochStore());
  const scope = { userId: 'u1', catId: 'codex', threadId: 't-replay' };
  const RUNTIME = 'thread-1';
  const event = { eventId: 'c1', runtimeSessionId: RUNTIME, evidenceRef: 'r1' };

  await owner.resolve({
    ...scope,
    disposition: { state: 'fresh', reason: 'no_prior_session', evidenceRef: 'e1', runtimeSessionId: RUNTIME },
  });
  await owner.observeCompaction({ ...scope, event });
  const consumed = await owner.resolve({
    ...scope,
    disposition: { state: 'resumed', reason: 'resume_confirmed', evidenceRef: 'e2', runtimeSessionId: RUNTIME },
  });
  assert.equal(consumed.contextMode, 'cold');
  await owner.confirmColdConsumed({ ...scope, contextEpoch: consumed.contextEpoch });

  const replay = await owner.observeCompaction({ ...scope, event });
  assert.equal(replay.replayed, true, 'the same event id is a replay');
  assert.equal(replay.contextEpoch, 2, 'a replay must not advance the epoch');

  const next = await owner.resolve({
    ...scope,
    disposition: { state: 'resumed', reason: 'resume_confirmed', evidenceRef: 'e3', runtimeSessionId: RUNTIME },
  });
  assert.equal(next.contextMode, 'hot', 'a replayed compaction must not re-arm an already consumed cold');
});
