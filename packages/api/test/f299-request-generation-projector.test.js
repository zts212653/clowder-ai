import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

let projectRequestGenerations;
let projectRequestGenerationGaps;
let requestGenerationEnvelopeV1Schema;

const DIGEST = `hmac-sha256:${'a'.repeat(64)}`;
const INVOCATION_ID = 'inv-f299';
const GENERATION_ID_1 = '00000000-0000-4000-8000-000000000001';
const GENERATION_ID_2 = '00000000-0000-4000-8000-000000000002';

before(async () => {
  ({ projectRequestGenerationGaps, projectRequestGenerations } = await import(
    '../dist/domains/cats/services/session/RequestGenerationProjector.js'
  ));
  ({ requestGenerationEnvelopeV1Schema } = await import('../../shared/dist/index.js'));
});

function envelope({ ordinal = 1, sessionId = 'session-1', generationId = GENERATION_ID_1 } = {}) {
  return {
    v: 1,
    invocationId: INVOCATION_ID,
    sessionId,
    generationOrdinal: ordinal,
    requestGenerationId: generationId,
    promptGenerationId: DIGEST,
    assembledAt: 100 + ordinal,
    continuity: {
      coordinate: { provider: 'codex', carrier: 'app_server' },
      contextEpoch: ordinal,
      mode: ordinal === 1 ? 'cold' : 'hot',
      transition: ordinal === 1 ? 'scope_first_seen' : 'resumed',
      capability: 'exact',
      compactionRefs: [],
    },
    channels: [
      {
        channel: 'message',
        accuracy: 'exact',
        keyedContentDigest: DIGEST,
        byteLength: 5,
        body: 'hello',
        sourceRefs: [{ owner: 'message', ref: 'thread-1:message-1' }],
        injectionDecision: ordinal === 1 ? 'cold_identity_injected' : 'hot_delta_only',
      },
      {
        channel: 'provider_native_hidden',
        accuracy: 'unsupported',
        sourceRefs: [],
      },
    ],
    presentations: [],
    runtime: {
      requested: { provider: 'openai', carrier: 'app_server', model: 'gpt-5.6-sol' },
      providerNativeVisibility: 'unsupported',
    },
    tools: { finalSurface: 'unknown' },
    retryBoundary:
      ordinal === 1
        ? { attempt: 1 }
        : { attempt: 2, previousGenerationOrdinal: ordinal - 1, reason: 'missing_session' },
  };
}

function transcriptEvent(sessionId, event, eventNo) {
  return {
    v: 1,
    t: 100 + eventNo,
    threadId: 'thread-1',
    catId: 'codex-sol',
    sessionId,
    invocationId: INVOCATION_ID,
    eventNo,
    event,
  };
}

describe('F299 request-generation schema', () => {
  it('accepts the bounded exact envelope and rejects secret-bearing runtime fields', () => {
    assert.equal(requestGenerationEnvelopeV1Schema.parse(envelope()).runtime.requested.provider, 'openai');
    assert.throws(() =>
      requestGenerationEnvelopeV1Schema.parse({
        ...envelope(),
        runtime: {
          ...envelope().runtime,
          requested: { ...envelope().runtime.requested, env: { OPENAI_API_KEY: 'secret' } },
        },
      }),
    );
  });

  it('rejects raw content hashes and exactness claims without exact body evidence', () => {
    assert.throws(() => requestGenerationEnvelopeV1Schema.parse({ ...envelope(), promptGenerationId: 'sha256:abc' }));
    assert.throws(() =>
      requestGenerationEnvelopeV1Schema.parse({
        ...envelope(),
        channels: [{ channel: 'message', accuracy: 'exact', sourceRefs: [] }],
      }),
    );
    assert.throws(() =>
      requestGenerationEnvelopeV1Schema.parse({
        ...envelope(),
        channels: [{ channel: 'message', accuracy: 'unknown', sourceRefs: [], body: 'must-not-persist' }],
      }),
    );
  });

  it('rejects exact or declared-only tool claims without the corresponding keyed set hash', () => {
    assert.throws(
      () => requestGenerationEnvelopeV1Schema.parse({ ...envelope(), tools: { finalSurface: 'exact' } }),
      /exact tool surfaces require a schema-set hash/,
    );
    assert.throws(
      () => requestGenerationEnvelopeV1Schema.parse({ ...envelope(), tools: { finalSurface: 'declared_only' } }),
      /declared-only tool surfaces require a server-set hash/,
    );
  });
});

describe('F299 request-generation projection', () => {
  it('orders one child across Sessions and reveals exact bytes only when every source is available', () => {
    const first = envelope();
    const second = envelope({ ordinal: 2, sessionId: 'session-2', generationId: GENERATION_ID_2 });
    const events = [
      transcriptEvent('session-2', { type: 'request_generation_assembled', envelope: second }, 0),
      transcriptEvent(
        'session-1',
        {
          type: 'request_generation_terminal',
          requestGenerationId: GENERATION_ID_1,
          generationOrdinal: 1,
          terminalAt: 120,
          outcome: 'replaced',
          reason: 'missing_session',
        },
        1,
      ),
      transcriptEvent('session-1', { type: 'request_generation_assembled', envelope: first }, 0),
      transcriptEvent(
        'session-2',
        {
          type: 'request_generation_observed',
          requestGenerationId: GENERATION_ID_2,
          generationOrdinal: 2,
          observedAt: 130,
          evidence: {
            provider: 'openai',
            carrier: 'app_server',
            model: 'gpt-5.6-sol',
            evidenceRef: 'provider:turn-2',
          },
        },
        1,
      ),
    ];

    const hidden = projectRequestGenerations(events);
    assert.deepEqual(
      hidden.map((generation) => generation.envelope.sessionId),
      ['session-1', 'session-2'],
    );
    assert.equal(hidden[0].envelope.channels[0].state, 'redacted');
    assert.equal(hidden[0].envelope.channels[0].body, undefined);
    assert.equal(hidden[1].observed.evidence.evidenceRef, 'provider:turn-2');

    const revealed = projectRequestGenerations(events, () => 'available');
    assert.equal(revealed[0].envelope.channels[0].state, 'available');
    assert.equal(revealed[0].envelope.channels[0].body, 'hello');
  });

  it('keeps intact generations visible and projects ordinal gaps as typed unknown evidence', () => {
    const second = envelope({ ordinal: 2, sessionId: 'session-2', generationId: GENERATION_ID_2 });
    const events = [transcriptEvent('session-2', { type: 'request_generation_assembled', envelope: second }, 0)];
    assert.deepEqual(
      projectRequestGenerations(events).map((generation) => generation.envelope.generationOrdinal),
      [2],
    );
    assert.deepEqual(projectRequestGenerationGaps(events), [
      { kind: 'evidence_gap', fromOrdinal: 1, toOrdinal: 1, state: 'unknown', reason: 'ordinal_gap' },
    ]);
  });

  it('still fails closed on duplicate ordinals and mismatched observed identities', () => {
    const first = envelope();

    assert.throws(
      () =>
        projectRequestGenerations([
          transcriptEvent('session-1', { type: 'request_generation_assembled', envelope: first }, 0),
          transcriptEvent('session-1', { type: 'request_generation_assembled', envelope: first }, 1),
        ]),
      /ordinal_duplicate/,
    );
    assert.throws(
      () =>
        projectRequestGenerations([
          transcriptEvent('session-1', { type: 'request_generation_assembled', envelope: first }, 0),
          transcriptEvent(
            'session-1',
            {
              type: 'request_generation_observed',
              requestGenerationId: GENERATION_ID_2,
              generationOrdinal: 1,
              observedAt: 110,
              evidence: { provider: 'openai', carrier: 'app_server', evidenceRef: 'provider:turn-1' },
            },
            1,
          ),
        ]),
      /identity_mismatch/,
    );
  });

  it('projects hard-deleted source state without retaining the exact body', () => {
    const projected = projectRequestGenerations(
      [transcriptEvent('session-1', { type: 'request_generation_assembled', envelope: envelope() }, 0)],
      () => 'deleted',
    );
    assert.equal(projected[0].envelope.channels[0].state, 'deleted');
    assert.equal(projected[0].envelope.channels[0].body, undefined);
  });
});
