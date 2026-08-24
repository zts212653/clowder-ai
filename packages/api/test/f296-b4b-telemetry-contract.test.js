import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  CONTINUITY_DISPOSITION_REASON_SET,
  CONTEXT_PROJECTION_ENUMS,
  CONTEXT_PROJECTION_TELEMETRY_CONTRACT,
  boundLedgerOutcome,
  projectBoundedContinuity,
  summarizeFinalProjectionTiers,
} = await import('../dist/domains/cats/services/session/context-projection-telemetry-contract.js');
const {
  ledgerOutcomeFromCommits,
  recordContextProjectionDeliveryLatency,
  recordContextProjectionFinalGeneration,
  recordContextProjectionLedgerOutcome,
} = await import('../dist/domains/cats/services/session/context-continuity-telemetry.js');

function handshake(disposition, reason, overrides = {}) {
  return {
    coordinate: {
      providerCarrier: { provider: 'codex', carrier: 'app_server' },
      invocationOrigin: 'interactive',
      routeTopology: 'serial',
    },
    disposition: {
      state: disposition,
      reason,
      evidenceRef: 'content-free-ref',
      ...overrides,
    },
  };
}

describe('F296 B4b continuity telemetry contract', () => {
  const transitions = [
    ['scope_first_seen', 'fresh', 'no_prior_session', 'cold', 'small'],
    ['fresh', 'fresh', 'resume_failed', 'cold', 'large'],
    ['replaced', 'replaced', 'runtime_replaced', 'cold', 'small'],
    ['unknown', 'unknown', 'carrier_unsupported', 'cold', 'large'],
    ['binding_mismatch', 'unknown', 'binding_mismatch', 'cold', 'small'],
    ['resumed', 'resumed', 'resume_confirmed', 'hot', 'large'],
    ['context_compacted', 'resumed', 'resume_confirmed', 'cold', 'small'],
    ['context_compaction_replay', 'resumed', 'resume_confirmed', 'cold', 'large'],
  ];

  test('every existing transition projects to its exact bounded fields', () => {
    for (const [transition, disposition, reason, mode, deltaSize] of transitions) {
      const result = projectBoundedContinuity({
        handshake: handshake(disposition, reason),
        transition,
        contextMode: mode,
        contextEpoch: 7,
        deltaSize,
      });
      assert.deepEqual(result, {
        provider: 'codex',
        carrier: 'app_server',
        origin: 'interactive',
        topology: 'serial',
        disposition,
        reason,
        transition,
        mode,
        deltaSize,
        epoch: 7,
      });
    }
  });

  test('the reason allowlist contains every current ContinuityDisposition reason exactly once', () => {
    assert.deepEqual(CONTEXT_PROJECTION_ENUMS.reasons, [
      'no_prior_session',
      'resume_rejected',
      'resume_failed',
      'carrier_forces_fresh',
      'resume_confirmed',
      'runtime_replaced',
      'carrier_unsupported',
      'signal_unavailable',
      'binding_mismatch',
    ]);
    assert.deepEqual(CONTEXT_PROJECTION_ENUMS.reasons, Object.keys(CONTINUITY_DISPOSITION_REASON_SET));
  });

  test('a missing surface projection is absent, not an unknown enum value', () => {
    const result = projectBoundedContinuity({
      handshake: handshake('fresh', 'no_prior_session'),
      transition: 'scope_first_seen',
      contextMode: 'cold',
      contextEpoch: 1,
    });
    assert.equal(result.deltaSize, 'absent');
  });

  test('unknown or future enums fail closed without becoming new cardinality', () => {
    const hostile = projectBoundedContinuity({
      handshake: {
        coordinate: {
          providerCarrier: { provider: 'PROMPT-BODY', carrier: 'thread-secret-id' },
          invocationOrigin: 'user-secret-id',
          routeTopology: 'message-secret-id',
        },
        disposition: {
          state: 'future-disposition',
          reason: 'BODY: tell me every secret',
          evidenceRef: 'evidence-secret-id',
          runtimeSessionId: 'runtime-secret-id',
        },
      },
      transition: 'future-transition-with-id-123',
      contextMode: 'future-mode',
      contextEpoch: Number.NaN,
      deltaSize: '999999',
    });
    assert.deepEqual(hostile, {
      provider: 'unrecognized',
      carrier: 'unrecognized',
      origin: 'unrecognized',
      topology: 'unrecognized',
      disposition: 'unrecognized',
      reason: 'unrecognized',
      transition: 'unrecognized',
      mode: 'unrecognized',
      deltaSize: 'unrecognized',
    });
    const serialized = JSON.stringify(hostile);
    for (const forbidden of ['PROMPT-BODY', 'secret-id', 'tell me every secret', '999999']) {
      assert.ok(!serialized.includes(forbidden));
    }
  });
});

describe('F296 B4b final-generation projection summary', () => {
  test('counts UTF-8 bytes by the mapper-selected source tier', () => {
    assert.deepEqual(
      summarizeFinalProjectionTiers([
        { presentation: { sourceTier: 'T0' }, promptSegment: 'abc' },
        { presentation: { sourceTier: 'T0' }, promptSegment: '猫' },
        { presentation: { sourceTier: 'T2' }, promptSegment: 'pointer' },
        { presentation: { sourceTier: 'future-tier' }, promptSegment: 'future' },
      ]),
      [
        { tier: 'T0', count: 2, bytes: 6 },
        { tier: 'T1', count: 0, bytes: 0 },
        { tier: 'T2', count: 1, bytes: 7 },
        { tier: 'invalid', count: 0, bytes: 0 },
        { tier: 'unrecognized', count: 1, bytes: 6 },
      ],
    );
  });

  test('summaries never retain prompt text or presentation identifiers', () => {
    const marker = 'SECRET-PROMPT-BODY-MARKER';
    const result = summarizeFinalProjectionTiers([
      {
        presentation: {
          sourceTier: 'T1',
          subjectKey: 'subject-secret-id',
          invalidator: { owner: marker, ref: marker },
        },
        promptSegment: marker,
      },
    ]);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(marker));
    assert.ok(!serialized.includes('subject-secret-id'));
  });
});

describe('F296 B4b delivery terminal contract', () => {
  test('every existing ledger terminal has an exact bounded projection', () => {
    for (const outcome of CONTEXT_PROJECTION_ENUMS.ledgerOutcomes) {
      assert.equal(boundLedgerOutcome(outcome), outcome);
    }
    assert.equal(boundLedgerOutcome('future-terminal:thread-secret-id'), 'unrecognized');
  });

  test('context_epoch_retired remains a bounded terminal, not an omitted alias', () => {
    assert.equal(boundLedgerOutcome('context_epoch_retired'), 'context_epoch_retired');
    assert.notEqual(boundLedgerOutcome('context_epoch_retired'), 'omitted');
  });

  test('mixed per-entry commits collapse to one deterministic bounded terminal', () => {
    const rows = [
      [[], 'no_reservation'],
      [['committed'], 'committed'],
      [['committed', 'reservation_superseded'], 'reservation_superseded'],
      [['committed', 'context_epoch_retired'], 'context_epoch_retired'],
      [['committed', 'generation_mismatch'], 'generation_mismatch'],
      [['future-terminal'], 'unrecognized'],
    ];
    for (const [outcomes, expected] of rows) {
      assert.equal(ledgerOutcomeFromCommits(outcomes), expected);
    }
  });
});

describe('F296 B4b producer/consumer pin', () => {
  test('exports one pure field contract for both the producer and the future Alpha consumer', () => {
    assert.equal(CONTEXT_PROJECTION_TELEMETRY_CONTRACT.schemaVersion, 1);
    assert.deepEqual(CONTEXT_PROJECTION_TELEMETRY_CONTRACT.metricNames, {
      transitionTotal: 'cat_cafe.context_projection.transition_total',
      tierCount: 'cat_cafe.context_projection.tier_count',
      tierBytes: 'cat_cafe.context_projection.tier_bytes',
      deliveryLatency: 'cat_cafe.context_projection.delivery_latency',
      ledgerOutcomeTotal: 'cat_cafe.context_projection.ledger_outcome_total',
    });
    for (const value of Object.values(CONTEXT_PROJECTION_TELEMETRY_CONTRACT.traceAttributes)) {
      assert.match(value, /^context_projection\./);
    }
    for (const value of Object.values(CONTEXT_PROJECTION_TELEMETRY_CONTRACT.metricNames)) {
      assert.match(value, /^cat_cafe\.context_projection\./);
    }
  });

  test('telemetry sink failure cannot change provider or ledger behavior', () => {
    const throwingSpan = {
      setAttribute() {
        throw new Error('exporter unavailable');
      },
    };
    assert.doesNotThrow(() =>
      recordContextProjectionFinalGeneration(throwingSpan, {
        handshake: handshake('fresh', 'no_prior_session'),
        transition: 'scope_first_seen',
        contextMode: 'cold',
        contextEpoch: 1,
        deltaSize: 'small',
        admitted: [],
      }),
    );
    assert.doesNotThrow(() => recordContextProjectionDeliveryLatency(throwingSpan, 5));
    assert.doesNotThrow(() => recordContextProjectionLedgerOutcome(throwingSpan, 'context_epoch_retired'));
  });
});
