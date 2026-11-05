import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RECALL_OPPORTUNITY_CATALOG_VERSION } from '@cat-cafe/shared';
import { prepareProviderPresentationAttempt } from '../src/domains/cats/services/agents/invocation/provider-presentation-delivery.js';
import {
  type ContextPresentationEnvelope,
  mapToPresentation,
} from '../src/domains/cats/services/session/context/context-presentation.js';
import {
  InMemoryPresentationLedgerStore,
  PresentationLedger,
} from '../src/domains/cats/services/session/context/PresentationLedger.js';

function reference(): ContextPresentationEnvelope<string> {
  const anchor = 'profile:opening-primer:astra:astra';
  const subjectKey = `memory-cue:profile:${anchor}:consumer:astra`;
  const asOf = { kind: 'version' as const, value: 'sha256:approved-v1' };
  const invalidator = { owner: 'profile_repository', ref: `${anchor}@${asOf.value}` };
  const entryVersion = `recall-catalog:${RECALL_OPPORTUNITY_CATALOG_VERSION}:fresh_context_sources:context_epoch`;
  return {
    candidate: {
      subjectKey,
      asOf,
      sourceTier: 'T2',
      requested: 'clue',
      epistemicCeiling: 'historical_clue',
      invalidator,
      historicalClueAdmission: {
        entryVersion,
        policyRef: 'F332.ProfileOpeningReference',
        sourceAnchor: anchor,
        sourceRevision: asOf.value,
      },
    },
    admission: {
      opportunityId: 'opening-1',
      opportunityKind: 'recall',
      producerOwner: 'context_epoch',
      consumerScope: { kind: 'invocation', ownerUserId: 'owner', threadId: 'thread', invocationId: 'invocation' },
      entryVersion,
      subjectKey,
      asOf,
      sourceRefs: [anchor],
      eligibleSurfaces: ['dynamic_context'],
      presentationPolicyRef: 'F332.ProfileOpeningReference',
      tokenBudget: 900,
      dedupeKey: 'opening-1',
      expiresAt: Date.now() + 300000,
      invalidators: [invalidator],
      epistemicCeiling: 'historical_clue',
    },
    segments: {
      clue: '参考 · 截至 2026-10-03\n我们一起完成了合奏。\n原消息：thread:source#message',
      pointer: 'read current source',
    },
    receipt: 'opening-1',
    validateCurrent: async () => true,
  };
}

test('fresh approved relationship reaches the final provider prompt as historical reference', async () => {
  const envelope = reference();
  assert.equal(mapToPresentation(envelope.candidate).presentation, 'clue');
  const attempt = await prepareProviderPresentationAttempt({
    envelopes: [envelope],
    ledger: new PresentationLedger(new InMemoryPresentationLedgerStore()),
    scope: { scopeKey: 'owner::astra::thread', contextEpoch: 1 },
    opportunityContext: {
      ownerUserId: 'owner',
      threadId: 'thread',
      invocationId: 'invocation',
      consumerCatId: 'astra',
      surface: 'dynamic_context',
      now: Date.now(),
    },
    buildEffectivePrompt: (segments) => ['用户当前话题', ...segments].join('\n'),
  });
  assert.equal(attempt.admitted.length, 1);
  assert.match(attempt.effectivePrompt, /完成了合奏/);
  assert.equal(attempt.admitted[0]!.presentation.sourceTier, 'T2');
  await attempt.release('test-not-submitted');
});

test('the exception does not admit a generic profile, another consumer, or a task-only entry', () => {
  const { candidate } = reference();
  for (const changed of [
    { ...candidate, subjectKey: candidate.subjectKey.replace(':consumer:astra', ':consumer:other') },
    {
      ...candidate,
      historicalClueAdmission: { ...candidate.historicalClueAdmission!, sourceAnchor: 'profile:primer:astra:astra' },
    },
    {
      ...candidate,
      historicalClueAdmission: {
        ...candidate.historicalClueAdmission!,
        entryVersion: `recall-catalog:${RECALL_OPPORTUNITY_CATALOG_VERSION}:authorized_task_sources:task_action_custody`,
      },
    },
  ])
    assert.equal(mapToPresentation(changed).presentation, 'pointer');
});
