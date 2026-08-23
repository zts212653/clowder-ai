// F296 B4a — provider-owned continuity preflight on the Codex app-server.
//
// The claims under test are the ones Gate 0 proved dynamically against a real
// `codex app-server` (codex-cli 0.147.0, 2026-08-20):
//   * `thread/start` / `thread/resume` return a trustworthy runtime id strictly
//     before `turn/start`, so a verdict exists before any prompt byte is sent;
//   * a stale resume is *rejected* by the provider rather than silently
//     substituted, so `replaced` is an observed fact and not an inference.
// See docs/features/evidence/F296/gate0-app-server-dynamic-probe.md
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  continuityDispositionFromProviderEvidence,
  resolveContextContinuity,
  supportsProviderContinuityPreflight,
} from '../dist/domains/cats/services/agents/invocation/context-continuity.js';
import {
  CodexAppServerClient,
  continuityEvidenceFromVerdict,
} from '../dist/domains/cats/services/agents/providers/CodexAppServerClient.js';
import {
  isThreadNotResumableRejection,
  resolveCodexAppServerThread,
} from '../dist/domains/cats/services/agents/providers/CodexAppServerThreadResolver.js';
import { CodexAppServerRpcError } from '../dist/domains/cats/services/agents/providers/codex-app-server-rpc-error.js';

const APP_SERVER_CAPABILITY = {
  provider: 'openai',
  carrier: 'app_server',
  reportsRuntimeWindow: false,
  authoritativeUsage: false,
  usageTelemetry: 'unavailable',
  nativeWindowControl: false,
  nativeCompressionControl: false,
  observesCompression: true,
  reason: 'test',
};

const COORDINATE = {
  providerCarrier: { provider: 'codex', carrier: 'app_server' },
  invocationOrigin: 'interactive',
  routeTopology: 'independent',
};

class AsyncInbox {
  #values = [];
  #waiters = [];
  #closed = false;
  push(value) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.#values.push(value);
  }
  close() {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push({ resolve }));
      },
    };
  }
}

/**
 * A wire that reproduces the Gate 0 observations: resume echoes the requested
 * id, and an unknown id is answered with a JSON-RPC error rather than a
 * different thread.
 */
class PreflightWire {
  constructor(options = {}) {
    this.inbox = new AsyncInbox();
    this.writes = [];
    this.knownThreadIds = new Set(options.knownThreadIds ?? []);
    this.startedThreadId = options.startedThreadId ?? 'thread-new';
    this.resumeReturnsThreadId = options.resumeReturnsThreadId;
    this.compactionAfterResume = options.compactionAfterResume ?? false;
    this.rejectTurnStart = options.rejectTurnStart ?? false;
  }
  read() {
    return this.inbox;
  }
  async write(message) {
    this.writes.push(message);
    if (message.method === 'initialize') this.inbox.push({ id: message.id, result: {} });
    if (message.method === 'thread/start') {
      this.inbox.push({ id: message.id, result: { thread: { id: this.startedThreadId } } });
    }
    if (message.method === 'thread/resume') {
      const requested = message.params.threadId;
      if (this.resumeReturnsThreadId) {
        this.inbox.push({ id: message.id, result: { thread: { id: this.resumeReturnsThreadId } } });
      } else if (this.knownThreadIds.has(requested)) {
        this.inbox.push({ id: message.id, result: { thread: { id: requested } } });
        if (this.compactionAfterResume) {
          // An authoritative compaction lands between the verdict and turn/start:
          // it is buffered, not yet delivered to anyone.
          this.inbox.push({
            method: 'item/completed',
            params: {
              threadId: requested,
              turnId: 'turn-prior',
              item: { type: 'contextCompaction', id: 'compaction-1' },
            },
          });
        }
      } else {
        // Gate 0 observed exactly this rejection shape.
        this.inbox.push({
          id: message.id,
          error: { code: -32600, message: `no rollout found for thread id ${requested}` },
        });
      }
    }
    if (message.method === 'turn/start') {
      if (this.rejectTurnStart) {
        this.inbox.push({ id: message.id, error: { code: -32000, message: 'turn rejected by provider' } });
        return;
      }
      this.inbox.push({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
      this.inbox.push({
        method: 'turn/completed',
        params: { threadId: message.params.threadId, turn: { id: 'turn-1', status: 'completed' } },
      });
    }
  }
  async terminate() {
    this.inbox.close();
  }
  async close() {
    this.inbox.close();
  }
}

async function drain(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function preflightPrompt(bytes, record) {
  return {
    kind: 'preflight',
    settle: async (input) => {
      record.calls.push(input);
      return { prompt: bytes };
    },
  };
}

test('the final prompt bytes cannot exist before the provider verdict', async () => {
  const wire = new PreflightWire({ knownThreadIds: ['thread-known'] });
  const client = new CodexAppServerClient({ wire });
  const record = { calls: [] };
  await drain(
    client.run({
      prompt: preflightPrompt('FINAL-BYTES', record),
      thread: { kind: 'resume', threadId: 'thread-known' },
    }),
  );

  const resumeIndex = wire.writes.findIndex((m) => m.method === 'thread/resume');
  const turnIndex = wire.writes.findIndex((m) => m.method === 'turn/start');
  assert.ok(resumeIndex >= 0, 'thread/resume must be issued');
  assert.ok(turnIndex > resumeIndex, 'turn/start must come strictly after the resume request');
  assert.equal(record.calls.length, 1, 'settle runs exactly once per accepted turn');
  assert.equal(
    wire.writes[turnIndex].params.input[0].text,
    'FINAL-BYTES',
    'the only bytes sent must be the ones settle returned',
  );
});

test('resumed is minted only from an exact id echo; a different id is never coerced', async () => {
  const wire = new PreflightWire({ resumeReturnsThreadId: 'thread-other' });
  const client = new CodexAppServerClient({ wire });
  const record = { calls: [] };
  await drain(
    client.run({
      prompt: preflightPrompt('bytes', record),
      thread: { kind: 'resume', threadId: 'thread-requested' },
    }),
  );
  assert.equal(record.calls[0].evidence.kind, 'mismatched', 'a differing id is mismatched, not resumed');
  const disposition = continuityDispositionFromProviderEvidence({
    evidence: record.calls[0].evidence,
    coordinate: COORDINATE,
    invocationId: 'inv-1',
  });
  assert.equal(disposition.state, 'unknown');
  assert.equal(disposition.reason, 'binding_mismatch');
});

test('an exact id echo mints resumed', async () => {
  const wire = new PreflightWire({ knownThreadIds: ['thread-known'] });
  const client = new CodexAppServerClient({ wire });
  const record = { calls: [] };
  await drain(
    client.run({
      prompt: preflightPrompt('bytes', record),
      thread: { kind: 'resume', threadId: 'thread-known' },
    }),
  );
  assert.deepEqual(record.calls[0].evidence, {
    kind: 'resumed',
    requestedRuntimeSessionId: 'thread-known',
    runtimeSessionId: 'thread-known',
  });
  const disposition = continuityDispositionFromProviderEvidence({
    evidence: record.calls[0].evidence,
    coordinate: COORDINATE,
    invocationId: 'inv-1',
  });
  assert.equal(disposition.state, 'resumed');
  assert.equal(disposition.reason, 'resume_confirmed');
  assert.equal(disposition.runtimeSessionId, 'thread-known');
});

test('a provider-rejected stale resume becomes replaced, and only the new runtime receives bytes', async () => {
  const wire = new PreflightWire({ knownThreadIds: [], startedThreadId: 'thread-fresh' });
  const client = new CodexAppServerClient({ wire });
  const record = { calls: [] };
  await drain(
    client.run({
      prompt: preflightPrompt('GENERATION-B', record),
      thread: { kind: 'resume', threadId: 'thread-stale' },
    }),
  );

  assert.equal(record.calls.length, 1, 'exactly one generation is built for the replacement');
  assert.deepEqual(record.calls[0].evidence, {
    kind: 'replaced',
    requestedRuntimeSessionId: 'thread-stale',
    runtimeSessionId: 'thread-fresh',
  });
  const turnStarts = wire.writes.filter((m) => m.method === 'turn/start');
  assert.equal(turnStarts.length, 1, 'no generation was sent to the stale runtime');
  assert.equal(turnStarts[0].params.threadId, 'thread-fresh');
  assert.equal(turnStarts[0].params.input[0].text, 'GENERATION-B');

  const disposition = continuityDispositionFromProviderEvidence({
    evidence: record.calls[0].evidence,
    coordinate: COORDINATE,
    invocationId: 'inv-1',
  });
  assert.equal(disposition.state, 'replaced');
  assert.equal(disposition.previousRuntimeSessionId, 'thread-stale');
  assert.equal(disposition.runtimeSessionId, 'thread-fresh');
});

test('a transport failure before a verdict yields no continuity claim and no bytes', async () => {
  const wire = new PreflightWire({ knownThreadIds: ['thread-known'] });
  wire.write = async function write(message) {
    this.writes.push(message);
    if (message.method === 'initialize') this.inbox.push({ id: message.id, result: {} });
    if (message.method === 'thread/resume') this.inbox.close(); // pipe dies, no verdict
  };
  const client = new CodexAppServerClient({ wire });
  const record = { calls: [] };
  await assert.rejects(
    drain(
      client.run({
        prompt: preflightPrompt('bytes', record),
        thread: { kind: 'resume', threadId: 'thread-known' },
      }),
    ),
  );
  assert.equal(record.calls.length, 0, 'no generation may be built without a verdict');
  assert.equal(
    wire.writes.filter((m) => m.method === 'turn/start').length,
    0,
    'no bytes may be sent without a verdict',
  );
});

test('a broken pipe is not answered with a fallback start', async () => {
  // Only a JSON-RPC error is a provider verdict. A plain transport Error must
  // propagate, or a dead pipe would silently manufacture a `replaced` runtime.
  const requests = [];
  await assert.rejects(
    resolveCodexAppServerThread({
      thread: { kind: 'resume', threadId: 'thread-a' },
      params: { threadId: 'thread-a' },
      localLiveLease: false,
      now: () => 0,
      request: async (method) => {
        requests.push(method);
        if (method === 'thread/resume') throw new Error('Codex app-server stream closed');
        return { thread: { id: 'thread-b' } };
      },
    }),
    /stream closed/,
  );
  assert.deepEqual(requests, ['thread/resume'], 'no fallback thread/start may be attempted');
});

test('a JSON-RPC rejection is answered with a fallback start', async () => {
  const requests = [];
  const verdict = await resolveCodexAppServerThread({
    thread: { kind: 'resume', threadId: 'thread-a' },
    params: { threadId: 'thread-a' },
    startParams: {},
    localLiveLease: false,
    now: () => 0,
    request: async (method) => {
      requests.push(method);
      if (method === 'thread/resume') {
        throw new CodexAppServerRpcError({
          message: 'no rollout found for thread id thread-a',
          method: 'thread/resume',
        });
      }
      return { thread: { id: 'thread-b' } };
    },
  });
  assert.deepEqual(requests, ['thread/resume', 'thread/start']);
  assert.equal(verdict.kind, 'replaced');
  assert.equal(verdict.threadId, 'thread-b');
});

test('binding equality alone never produces resumed', () => {
  // The pre-provider handshake knows the id we intend to request. That is not
  // evidence, so it must stay unknown until the adapter speaks.
  const handshake = resolveContextContinuity({
    capability: APP_SERVER_CAPABILITY,
    invocationId: 'inv-1',
    requestedRuntimeSessionId: 'thread-known',
    invocationOrigin: 'interactive',
    routeTopology: 'independent',
    providerPreflightAvailable: true,
  });
  assert.equal(handshake.disposition.state, 'unknown');
  assert.equal(handshake.disposition.reason, 'signal_unavailable');
  assert.ok(supportsProviderContinuityPreflight(handshake));
});

test('an app-server carrier without an adapter seam stays carrier_unsupported', () => {
  const handshake = resolveContextContinuity({
    capability: APP_SERVER_CAPABILITY,
    invocationId: 'inv-1',
    requestedRuntimeSessionId: 'thread-known',
    invocationOrigin: 'interactive',
    routeTopology: 'independent',
  });
  assert.equal(handshake.disposition.state, 'unknown');
  assert.equal(
    handshake.disposition.reason,
    'carrier_unsupported',
    'declaring the seam elsewhere must not open the carrier by itself',
  );
});

test('every verdict maps to exactly one disposition row', () => {
  const rows = [
    [{ kind: 'started', threadId: 't1' }, 'fresh', 'no_prior_session'],
    [{ kind: 'resumed', requestedThreadId: 't1', threadId: 't1' }, 'resumed', 'resume_confirmed'],
    [{ kind: 'replaced', requestedThreadId: 't1', threadId: 't2' }, 'replaced', 'runtime_replaced'],
    [{ kind: 'mismatched', requestedThreadId: 't1', threadId: 't2' }, 'unknown', 'binding_mismatch'],
  ];
  for (const [verdict, state, reason] of rows) {
    const disposition = continuityDispositionFromProviderEvidence({
      evidence: continuityEvidenceFromVerdict(verdict),
      coordinate: COORDINATE,
      invocationId: 'inv-1',
    });
    assert.equal(disposition.state, state, `${verdict.kind} → ${state}`);
    assert.equal(disposition.reason, reason, `${verdict.kind} → ${reason}`);
  }
});

// --- kimi exact-HEAD review, P1 ---------------------------------------------
// A follow-up probe on codex-cli 0.147.0 (2026-08-20) showed the app-server
// answers BOTH a stale resume and our own malformed request with code -32600:
//
//   stale resume -> -32600 "no rollout found for thread id <uuid>"
//   our own bug  -> -32600 "Invalid request: missing field `threadId`"
//
// So "it is a JSON-RPC error" is not the same claim as "the thread is gone",
// and there is no code that separates them. Treating every rejection as a
// stale-resume verdict silently discards session continuity and buries the
// real bug behind a brand-new runtime.

test('a malformed thread/resume is never laundered into a replacement', async () => {
  for (const message of [
    'Invalid request: missing field `threadId`',
    'Invalid request: invalid type: integer `12345`, expected a string',
    'Invalid request: unknown variant `not-a-real-sandbox-mode`, expected one of `read-only`',
  ]) {
    const requests = [];
    await assert.rejects(
      resolveCodexAppServerThread({
        thread: { kind: 'resume', threadId: 'thread-a' },
        params: { threadId: 'thread-a' },
        startParams: {},
        localLiveLease: false,
        now: () => 0,
        request: async (method) => {
          requests.push(method);
          if (method === 'thread/resume') {
            throw new CodexAppServerRpcError({ message, method: 'thread/resume', code: -32600 });
          }
          return { thread: { id: 'thread-b' } };
        },
      }),
      new RegExp(message.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `"${message}" must propagate`,
    );
    assert.deepEqual(requests, ['thread/resume'], `"${message}" must not trigger a fallback start`);
  }
});

test('an unrecognised rejection fails loudly rather than replacing the runtime', async () => {
  // Fail-closed direction: we would rather lose the invocation than lose the
  // session silently. A future real not-found phrasing shows up as a loud
  // failure, which is recoverable; the opposite default is not.
  const requests = [];
  await assert.rejects(
    resolveCodexAppServerThread({
      thread: { kind: 'resume', threadId: 'thread-a' },
      params: { threadId: 'thread-a' },
      startParams: {},
      localLiveLease: false,
      now: () => 0,
      request: async (method) => {
        requests.push(method);
        if (method === 'thread/resume') {
          throw new CodexAppServerRpcError({ message: 'internal server error', method: 'thread/resume', code: -32603 });
        }
        return { thread: { id: 'thread-b' } };
      },
    }),
    /internal server error/,
  );
  assert.deepEqual(requests, ['thread/resume']);
});

test('only the observed not-found phrasing is recognised', () => {
  assert.equal(
    isThreadNotResumableRejection('no rollout found for thread id 8779b9d8-8daf-4746-b355-905be094b99f'),
    true,
  );
  for (const notFound of [
    'Invalid request: missing field `threadId`',
    'internal server error',
    'no rollout found',
    'thread thread-a already has an active writer',
    '',
  ]) {
    assert.equal(isThreadNotResumableRejection(notFound), false, `"${notFound}" must not be treated as not-found`);
  }
});

// --- Sol review #5, second round --------------------------------------------
// The first attempt gave the invocation a stable array so late ids would be
// visible. That was defeated one layer down: CodexCapacityRecoveryCheckpoint
// normalized the anchor in its CONSTRUCTOR, and the runner constructs it before
// client.run() — i.e. before `settle`. So it snapshotted an empty array and the
// exact ids were lost anyway. Testing the invocation's options alone could not
// see that; this drives the checkpoint itself.

test('a recovery anchor filled after construction is still seen by the checkpoint', async () => {
  const { CodexCapacityRecoveryCheckpoint } = await import(
    '../dist/domains/cats/services/agents/providers/CodexCapacityRecoveryCheckpoint.js'
  );

  // Exactly the preflight shape: the array exists at construction but is only
  // populated later, inside settle.
  const promptMessageIds = [];
  const checkpoint = new CodexCapacityRecoveryCheckpoint({
    threadId: 'thread-1',
    invocationId: 'inv-1',
    promptMessageIds,
  });

  assert.equal(checkpoint.hasExactAnchor(), false, 'nothing is known before settle');

  promptMessageIds.push('msg-a', 'msg-b');

  assert.equal(
    checkpoint.hasExactAnchor(),
    true,
    'once settle has produced the ids the anchor must be exact — a constructor-time copy loses them',
  );
  assert.deepEqual(checkpoint.snapshot().anchor.promptMessageIds, ['msg-a', 'msg-b']);
});

test('the checkpoint still normalizes and bounds a late-filled anchor', async () => {
  const { CodexCapacityRecoveryCheckpoint } = await import(
    '../dist/domains/cats/services/agents/providers/CodexCapacityRecoveryCheckpoint.js'
  );
  const promptMessageIds = [];
  const checkpoint = new CodexCapacityRecoveryCheckpoint({
    threadId: 'thread-1',
    invocationId: 'inv-1',
    promptMessageIds,
  });
  // Deferring normalization must not defer the bounds it enforces.
  promptMessageIds.push('dup', 'dup', '', '   ', 'x'.repeat(500));
  const ids = checkpoint.snapshot().anchor.promptMessageIds;
  assert.equal(ids.filter((id) => id === 'dup').length, 1, 'still deduplicated');
  assert.ok(!ids.includes(''), 'still drops empties');
  assert.ok(
    ids.every((id) => id.length <= 160),
    'still bounded per id',
  );
});

// --- cloud review at b0cf484c1 -----------------------------------------------
// A capacity-recovery turn sends `input: []` — it carries no prompt at all. But
// `settle()` ran unconditionally just above that branch, and settling is not a
// read: it drains buffered compactions, rebuilds a cold prompt, exposes new
// message ids and reserves a ledger generation. The bytes were then thrown
// away, while invokeSingleCat still confirmed the cold epoch consumed because
// the provider accepted *a* turn.
//
// Net effect: a compaction arriving between attempts could be marked consumed
// without ever reaching the provider, and the next invocation would project hot
// context over a cold rebuild that nobody ever saw. That is the precise failure
// this feature exists to prevent, reintroduced through the retry path.
test('a capacity-recovery turn settles nothing, because it sends no prompt', async () => {
  const wire = new PreflightWire({ knownThreadIds: ['thread-known'] });
  const client = new CodexAppServerClient({ wire });
  const record = { calls: [] };

  await drain(
    client.run({
      prompt: preflightPrompt('BYTES-THAT-WOULD-BE-DISCARDED', record),
      thread: { kind: 'resume', threadId: 'thread-known' },
      recoveryInstruction: 'resend the last turn under a smaller window',
    }),
  );

  const turn = wire.writes.find((m) => m.method === 'turn/start');
  assert.ok(turn, 'turn/start must still be issued for the recovery attempt');
  assert.deepEqual(turn.params.input, [], 'a recovery turn carries no prompt');
  assert.equal(
    record.calls.length,
    0,
    'settle must not run for a turn whose bytes are discarded — settling reserves a generation ' +
      'and consumes buffered compactions, so running it here marks work delivered that never left the process',
  );
});

test('a whitespace-only recovery instruction is a normal turn, consistently on both sides', async () => {
  // `input.recoveryInstruction?.trim()` turns '  ' into '', so "is this a
  // recovery turn" and "do we settle" must be the same question or the turn
  // sends a prompt it never built.
  const wire = new PreflightWire({ knownThreadIds: ['thread-known'] });
  const client = new CodexAppServerClient({ wire });
  const record = { calls: [] };

  await drain(
    client.run({
      prompt: preflightPrompt('REAL-BYTES', record),
      thread: { kind: 'resume', threadId: 'thread-known' },
      recoveryInstruction: '   ',
    }),
  );

  const turn = wire.writes.find((m) => m.method === 'turn/start');
  assert.equal(record.calls.length, 1, 'a blank instruction is not a recovery turn, so it settles normally');
  assert.equal(turn.params.input[0].text, 'REAL-BYTES', 'and the bytes it settled are the bytes it sends');
});

// --- @codex-sol + cloud, independently, at 87722019e ----------------------------
// Skipping the drain on a recovery turn traded one loss for another: the
// observation stays in the client's private queue, and `finally` closes the
// transport. A compaction that arrived before a rejected turn/start would then
// be destroyed with the client and never reach the epoch owner, so the next
// real invocation projects hot over a compaction nobody recorded.
//
// Recovery must skip building a generation. It must NOT skip persisting and
// delivering what the provider already told us.
test('a buffered compaction reaches the owner exactly once even when the recovery turn is rejected', async () => {
  const wire = new PreflightWire({
    knownThreadIds: ['thread-known'],
    compactionAfterResume: true,
    rejectTurnStart: true,
  });
  const client = new CodexAppServerClient({ wire });
  const record = { calls: [] };
  const seen = [];

  await assert.rejects(async () => {
    for await (const event of client.run({
      prompt: preflightPrompt('BYTES-THAT-WOULD-BE-DISCARDED', record),
      thread: { kind: 'resume', threadId: 'thread-known' },
      recoveryInstruction: 'resend the last turn under a smaller window',
    })) {
      if (event.type === 'app_server.context_compaction') seen.push(event.observation);
    }
  });

  assert.equal(record.calls.length, 0, 'a recovery turn must still not settle a generation');
  assert.equal(
    seen.length,
    1,
    'the buffered compaction must be delivered to the owner exactly once, before the turn can fail',
  );
  assert.equal(seen[0].runtimeSessionId, 'thread-known');
  assert.match(seen[0].evidenceRef, /^codex_app_server_context_compaction:thread-known:/);
});
