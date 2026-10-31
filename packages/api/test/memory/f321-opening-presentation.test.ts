import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapToPresentation } from '../../src/domains/cats/services/session/context/context-presentation.js';

test('only the exact admitted thread-opening source can present a T2 historical clue', () => {
  const admission = {
    entryVersion: 'recall-catalog:7:thread_opened:owner_message',
    policyRef: 'F321.ThreadOpeningClue',
    sourceAnchor: 'thread-overview:old',
    sourceRevision: 'revision',
  };
  const candidate = {
    subjectKey: 'memory-cue:thread_overview:thread-overview:old',
    asOf: { kind: 'version' as const, value: 'revision' },
    sourceTier: 'T2' as const,
    requested: 'clue' as const,
    epistemicCeiling: 'historical_clue' as const,
    historicalClueAdmission: admission,
    invalidator: { owner: 'thread_overview', ref: 'thread-overview:old@revision' },
  };
  assert.equal(mapToPresentation(candidate).presentation, 'clue');
  assert.equal(mapToPresentation({ ...candidate, historicalClueAdmission: undefined }).presentation, 'pointer');
  assert.equal(
    mapToPresentation({ ...candidate, historicalClueAdmission: { ...admission, entryVersion: 'free-text' } })
      .presentation,
    'pointer',
  );
  assert.equal(mapToPresentation({ ...candidate, invalidator: undefined }).presentation, 'pointer');
  assert.equal(
    mapToPresentation({ ...candidate, asOf: { kind: 'version', value: 'changed' } }).presentation,
    'pointer',
  );
});

test('the final provider boundary rejects a forged envelope policy for an otherwise valid historical clue', async () => {
  const { prepareProviderPresentationAttempt } = await import(
    '../../src/domains/cats/services/agents/invocation/provider-presentation-delivery.js'
  );
  const subjectKey = 'memory-cue:thread_overview:thread-overview:old';
  const asOf = { kind: 'version' as const, value: 'rev' };
  const candidate = {
    subjectKey,
    asOf,
    sourceTier: 'T2' as const,
    requested: 'clue' as const,
    epistemicCeiling: 'historical_clue' as const,
    invalidator: { owner: 'thread_overview', ref: 'thread-overview:old@rev' },
    historicalClueAdmission: {
      entryVersion: 'recall-catalog:7:thread_opened:owner_message',
      policyRef: 'F321.ThreadOpeningClue',
      sourceAnchor: 'thread-overview:old',
      sourceRevision: 'rev',
    },
  };
  const admission = {
    opportunityId: 'o',
    opportunityKind: 'recall' as const,
    producerOwner: 'owner_message',
    consumerScope: { kind: 'invocation' as const, ownerUserId: 'owner', threadId: 'new', invocationId: 'inv' },
    entryVersion: candidate.historicalClueAdmission.entryVersion,
    subjectKey,
    asOf,
    sourceRefs: ['thread-overview:old'],
    eligibleSurfaces: ['dynamic_context' as const],
    presentationPolicyRef: 'FORGED',
    tokenBudget: 500,
    dedupeKey: 'k',
    expiresAt: 10000,
    invalidators: [candidate.invalidator],
    epistemicCeiling: 'historical_clue' as const,
  };
  const ledger = {
    async reserve() {
      return {
        admitted: true as const,
        reservation: {
          address: { scopeKey: 's', entryField: 'e' },
          token: 't',
          expiresAtMs: 10000,
          promptGenerationId: 'g',
        },
      };
    },
    async release() {},
    async commit() {
      return { committed: true as const };
    },
  };
  const attempt = await prepareProviderPresentationAttempt({
    envelopes: [{ candidate, admission, segments: { clue: 'PRIVATE_CLUE', pointer: 'drill' }, receipt: {} }],
    ledger,
    scope: { scopeKey: 's', contextEpoch: 1 },
    opportunityContext: {
      ownerUserId: 'owner',
      threadId: 'new',
      invocationId: 'inv',
      consumerCatId: 'cat',
      surface: 'dynamic_context',
      now: 1,
    },
    buildEffectivePrompt: (s) => ['hello', ...s].join('\n'),
  });
  assert.equal(attempt.effectivePrompt, 'hello');
  assert.equal(attempt.omitted.length, 1);
});

test('owner cue metadata links to the same readable source thread and removes navigation after revocation', async () => {
  const { recallCueViewReader } = await import('../../src/routes/recall-cue-view.js');
  let readable = true;
  const cue = {
    invocation_id: 'inv',
    cue_id: 'cue',
    resolver_family: 'thread_overview' as const,
    source_anchor: 'thread-overview:old',
    source_revision: 'r',
    consumer_cat_id: 'cat',
  };
  const read = () =>
    recallCueViewReader({ ownerUserId: 'owner', threadId: 'new' }, async () => ({ href: null }), {
      async read() {
        return readable
          ? { status: 'ok' as const, payload: { threadId: 'old', title: 'Previous idea' } }
          : { status: 'not_available' as const, invalidationReason: 'scope_revoked' as const };
      },
    });
  assert.equal((await read()(cue)).href, '/thread/old');
  readable = false;
  const revoked = await read()(cue);
  assert.equal(revoked.href, null);
  assert.equal(revoked.title, undefined);
});
