import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  prepareProviderPresentationAttempt,
  promptGenerationId,
} from '../dist/domains/cats/services/agents/invocation/provider-presentation-delivery.js';
import { mintDeliveryReceipt } from '../dist/domains/cats/services/session/delivery-receipt.js';

function envelope(subjectKey, promptSegment, overrides = {}) {
  const asOf = { kind: 'version', value: 'revision-1' };
  return {
    candidate: {
      subjectKey,
      asOf,
      sourceTier: 'T0',
      requested: 'state',
      epistemicCeiling: overrides.epistemicCeiling ?? 'state',
      ...overrides,
    },
    segments: { state: promptSegment, pointer: promptSegment },
    admission: {
      opportunityId: `opportunity-${subjectKey}`,
      opportunityKind: 'write',
      producerOwner: 'test-owner',
      consumerScope: {
        kind: 'invocation',
        ownerUserId: 'owner',
        threadId: 'thread',
        invocationId: 'invocation',
      },
      entryVersion: 'test-entry:1',
      subjectKey,
      asOf,
      sourceRefs: ['test-source-ref'],
      eligibleSurfaces: ['dynamic_context'],
      presentationPolicyRef: 'F296.OpportunityPresentation',
      tokenBudget: 100,
      dedupeKey: `dedupe-${subjectKey}`,
      expiresAt: 10_000,
      invalidators: [{ owner: 'test-owner', ref: 'source_corrected' }],
      epistemicCeiling: overrides.epistemicCeiling ?? 'state',
    },
    receipt: { subjectKey },
  };
}

const opportunityContext = {
  ownerUserId: 'owner',
  threadId: 'thread',
  invocationId: 'invocation',
  consumerCatId: 'cat',
  surface: 'dynamic_context',
  now: 1_000,
};

function reservation(subjectKey, promptGenerationId) {
  return {
    address: { scopeKey: 'scope', entryField: subjectKey },
    token: `token-${subjectKey}`,
    expiresAtMs: 10_000,
    promptGenerationId,
  };
}

describe('F296 B3b-2 provider presentation boundary', () => {
  it('uses an owner-keyed prompt identity factory for every rebuilt generation', async () => {
    const digested = [];
    const attempt = await prepareProviderPresentationAttempt({
      envelopes: [],
      opportunityContext,
      buildEffectivePrompt: () => 'private prompt',
      createPromptGenerationId: async (value) => {
        digested.push(value);
        return `hmac-sha256:${'a'.repeat(64)}`;
      },
    });

    assert.equal(attempt.promptGenerationId, `hmac-sha256:${'a'.repeat(64)}`);
    assert.deepEqual(digested, ['private prompt']);
  });

  it('rehashes the exact final prompt after a rejected projection and releases superseded reservations', async () => {
    const calls = [];
    let reserveSequence = 0;
    const ledger = {
      async reserve(presentation, _scope, prompt) {
        calls.push(['reserve', presentation.subjectKey, prompt.promptGenerationId]);
        reserveSequence += 1;
        if (reserveSequence === 2) {
          return {
            admitted: false,
            reason: 'already_delivered_this_epoch',
            address: { scopeKey: 'scope', entryField: presentation.subjectKey },
          };
        }
        return {
          admitted: true,
          reservation: reservation(presentation.subjectKey, prompt.promptGenerationId),
        };
      },
      async release(reserved, reason) {
        calls.push(['release', reserved.address.entryField, reason]);
      },
      async commit(reserved, receipt) {
        calls.push(['commit', reserved.address.entryField, receipt.promptGenerationId]);
        assert.equal(receipt.promptGenerationId, reserved.promptGenerationId);
        return { committed: true };
      },
    };
    const attempt = await prepareProviderPresentationAttempt({
      envelopes: [envelope('subject-a', '<a/>'), envelope('subject-b', '<b/>')],
      ledger,
      scope: { scopeKey: 'owner::cat::thread', contextEpoch: 7 },
      opportunityContext,
      buildEffectivePrompt: (segments) => ['base', ...segments].join('\n'),
    });

    assert.equal(attempt.effectivePrompt, 'base\n<a/>');
    assert.equal(attempt.promptGenerationId, promptGenerationId(attempt.effectivePrompt));
    assert.deepEqual(
      attempt.admitted.map(({ envelope: admittedEnvelope }) => admittedEnvelope.receipt.subjectKey),
      ['subject-a'],
    );
    assert.deepEqual(
      attempt.omitted.map(({ receipt }) => receipt.subjectKey),
      ['subject-b'],
    );
    assert.deepEqual(calls.slice(0, 4), [
      ['reserve', 'subject-a', promptGenerationId('base\n<a/>\n<b/>')],
      ['reserve', 'subject-b', promptGenerationId('base\n<a/>\n<b/>')],
      ['release', 'subject-a', 'prompt_generation_rebuild'],
      ['reserve', 'subject-a', promptGenerationId('base\n<a/>')],
    ]);

    const commits = await attempt.confirm(
      mintDeliveryReceipt({
        promptGenerationId: attempt.promptGenerationId,
        providerReceivedAt: 123,
        providerAdapterId: 'openai:exec_json',
      }),
    );
    assert.deepEqual(
      commits.map(({ outcome }) => outcome),
      [{ committed: true }],
    );
    assert.deepEqual(calls.at(-1), ['commit', 'subject-a', attempt.promptGenerationId]);
  });

  it('applies mapper omission before touching the ledger', async () => {
    let reserveCalls = 0;
    const attempt = await prepareProviderPresentationAttempt({
      envelopes: [envelope('history', '<history/>', { sourceTier: 'invalid', requested: 'state' })],
      ledger: {
        async reserve() {
          reserveCalls += 1;
          throw new Error('mapper omission must not reserve');
        },
        async commit() {
          throw new Error('mapper omission must not commit');
        },
        async release() {
          throw new Error('mapper omission must not release');
        },
      },
      scope: { scopeKey: 'owner::cat::thread', contextEpoch: 7 },
      opportunityContext,
      buildEffectivePrompt: (segments) => ['base', ...segments].join('\n'),
    });

    assert.equal(attempt.effectivePrompt, 'base');
    assert.equal(reserveCalls, 0);
    assert.equal(attempt.admitted.length, 0);
    assert.equal(attempt.omitted.length, 1);
  });

  it('renders only the mapper-selected tier and never forwards a stronger producer body', async () => {
    const candidateEnvelope = envelope('history', 'unused');
    candidateEnvelope.candidate.sourceTier = 'T2';
    candidateEnvelope.candidate.requested = 'state';
    candidateEnvelope.segments = {
      state: 'SECRET HISTORICAL SUMMARY',
      pointer: 'Drill: graph opaque-handle',
    };
    const attempt = await prepareProviderPresentationAttempt({
      envelopes: [candidateEnvelope],
      ledger: {
        async reserve(presentation, _scope, prompt) {
          assert.equal(presentation.presentation, 'pointer');
          return {
            admitted: true,
            reservation: reservation(presentation.subjectKey, prompt.promptGenerationId),
          };
        },
        async commit() {
          return { committed: true };
        },
        async release() {},
      },
      scope: { scopeKey: 'owner::cat::thread', contextEpoch: 7 },
      opportunityContext,
      buildEffectivePrompt: (segments) => ['base', ...segments].join('\n'),
    });

    assert.equal(attempt.effectivePrompt, 'base\nDrill: graph opaque-handle');
    assert.doesNotMatch(attempt.effectivePrompt, /SECRET HISTORICAL SUMMARY/);
  });

  it('fails closed without an epoch scope and never invents process-local admission', async () => {
    let reserveCalls = 0;
    const attempt = await prepareProviderPresentationAttempt({
      envelopes: [envelope('subject-a', '<a/>')],
      ledger: {
        async reserve() {
          reserveCalls += 1;
          throw new Error('unsupported scope must not reserve');
        },
        async commit() {
          throw new Error('unsupported scope must not commit');
        },
        async release() {
          throw new Error('unsupported scope must not release');
        },
      },
      opportunityContext,
      buildEffectivePrompt: (segments) => ['base', ...segments].join('\n'),
    });

    assert.equal(attempt.effectivePrompt, 'base');
    assert.equal(reserveCalls, 0);
    assert.equal(attempt.admitted.length, 0);
    assert.equal(attempt.omitted.length, 1);
  });

  it('releases the partial batch when a later reservation fails loudly', async () => {
    const released = [];
    let reserveCalls = 0;
    await assert.rejects(
      prepareProviderPresentationAttempt({
        envelopes: [envelope('subject-a', '<a/>'), envelope('subject-b', '<b/>')],
        ledger: {
          async reserve(presentation, _scope, prompt) {
            reserveCalls += 1;
            if (reserveCalls === 2) throw new Error('redis unavailable');
            return {
              admitted: true,
              reservation: reservation(presentation.subjectKey, prompt.promptGenerationId),
            };
          },
          async commit() {
            throw new Error('not reached');
          },
          async release(reserved, reason) {
            released.push([reserved.address.entryField, reason]);
          },
        },
        scope: { scopeKey: 'owner::cat::thread', contextEpoch: 7 },
        opportunityContext,
        buildEffectivePrompt: (segments) => ['base', ...segments].join('\n'),
      }),
      /redis unavailable/,
    );
    assert.deepEqual(released, [['subject-a', 'reservation_batch_failed']]);
  });

  it('rejects unadmitted, expired, wrong-scope, or unsupported-surface opportunity envelopes before ledger access', async () => {
    const missingAdmission = envelope('missing', '<missing/>');
    delete missingAdmission.admission;
    const expired = envelope('expired', '<expired/>');
    expired.admission.expiresAt = opportunityContext.now;
    const wrongScope = envelope('wrong-scope', '<wrong-scope/>');
    wrongScope.admission.consumerScope.invocationId = 'another-invocation';
    const wrongSurface = envelope('wrong-surface', '<wrong-surface/>');
    wrongSurface.admission.eligibleSurfaces = ['deferred_queue'];
    let reserveCalls = 0;

    const attempt = await prepareProviderPresentationAttempt({
      envelopes: [missingAdmission, expired, wrongScope, wrongSurface],
      ledger: {
        async reserve() {
          reserveCalls += 1;
          throw new Error('invalid opportunity must not reserve');
        },
        async commit() {
          throw new Error('invalid opportunity must not commit');
        },
        async release() {
          throw new Error('invalid opportunity must not release');
        },
      },
      scope: { scopeKey: 'owner::cat::thread', contextEpoch: 99 },
      opportunityContext,
      buildEffectivePrompt: (segments) => ['base', ...segments].join('\n'),
    });

    assert.equal(attempt.effectivePrompt, 'base');
    assert.equal(attempt.admitted.length, 0);
    assert.equal(attempt.omitted.length, 4);
    assert.equal(reserveCalls, 0);
  });

  it('rejects admission metadata that disagrees with the projected subject, revision, or ceiling', async () => {
    const subjectMismatch = envelope('subject-mismatch', '<subject/>');
    subjectMismatch.admission.subjectKey = 'different-subject';
    const revisionMismatch = envelope('revision-mismatch', '<revision/>');
    revisionMismatch.admission.asOf = { kind: 'version', value: 'different-revision' };
    const ceilingMismatch = envelope('ceiling-mismatch', '<ceiling/>', {
      epistemicCeiling: 'mechanical_observation',
    });
    ceilingMismatch.admission.epistemicCeiling = 'pointer';

    const attempt = await prepareProviderPresentationAttempt({
      envelopes: [subjectMismatch, revisionMismatch, ceilingMismatch],
      ledger: {
        async reserve() {
          throw new Error('inconsistent opportunity must not reserve');
        },
        async commit() {
          throw new Error('inconsistent opportunity must not commit');
        },
        async release() {
          throw new Error('inconsistent opportunity must not release');
        },
      },
      scope: { scopeKey: 'owner::cat::thread', contextEpoch: 7 },
      opportunityContext,
      buildEffectivePrompt: (segments) => ['base', ...segments].join('\n'),
    });

    assert.equal(attempt.effectivePrompt, 'base');
    assert.equal(attempt.omitted.length, 3);
  });

  it('enforces the producer token budget at the provider boundary', async () => {
    const overBudget = envelope('over-budget', 'this rendering is intentionally over one token');
    overBudget.admission.tokenBudget = 1;
    const attempt = await prepareProviderPresentationAttempt({
      envelopes: [overBudget],
      ledger: {
        async reserve() {
          throw new Error('over-budget opportunity must not reserve');
        },
        async commit() {
          throw new Error('over-budget opportunity must not commit');
        },
        async release() {
          throw new Error('over-budget opportunity must not release');
        },
      },
      scope: { scopeKey: 'owner::cat::thread', contextEpoch: 7 },
      opportunityContext,
      buildEffectivePrompt: (segments) => ['base', ...segments].join('\n'),
    });

    assert.equal(attempt.effectivePrompt, 'base');
    assert.equal(attempt.omitted.length, 1);
  });
});
