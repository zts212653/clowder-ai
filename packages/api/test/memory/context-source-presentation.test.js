import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectMemoryCueCapacity } from '../../dist/domains/cats/services/agents/invocation/memory-cue-presentation-capacity.js';
import { prepareProviderPresentationAttempt } from '../../dist/domains/cats/services/agents/invocation/provider-presentation-delivery.js';
import {
  InMemoryPresentationLedgerStore,
  PresentationLedger,
} from '../../dist/domains/cats/services/session/context/PresentationLedger.js';
import { ContextSourceWorkBudget } from '../../dist/domains/memory/cue/ContextSourceWorkBudget.js';
import { MemoryCuePlaneService } from '../../dist/domains/memory/cue/MemoryCuePlaneService.js';

function item(source, entry = 'fresh_context_sources', family = 'project_knowledge', size = 40) {
  const subjectKey = `memory-cue:${family}:${source}:consumer:cat`,
    asOf = { kind: 'version', value: 'current' };
  const segment = `${source} ${'token '.repeat(size)}`;
  return {
    promptSegment: segment,
    envelope: {
      candidate: { subjectKey, asOf, sourceTier: 'T2', requested: 'pointer', epistemicCeiling: 'pointer' },
      admission: {
        opportunityId: `opportunity-${entry}`,
        opportunityKind: 'recall',
        producerOwner: 'context_epoch',
        consumerScope: { kind: 'invocation', ownerUserId: 'owner', threadId: 'thread', invocationId: 'invocation' },
        entryVersion: `recall-catalog:7:${entry}:context_epoch`,
        subjectKey,
        asOf,
        sourceRefs: [source],
        eligibleSurfaces: ['dynamic_context'],
        presentationPolicyRef: 'F296.OpportunityPresentation',
        tokenBudget: 900,
        dedupeKey: entry,
        expiresAt: Date.now() + 300000,
        invalidators: [{ owner: 'source', ref: source }],
        epistemicCeiling: 'pointer',
      },
      segments: { pointer: segment },
      receipt: { source },
    },
  };
}
test('actual mapped segments enforce combined opportunity cap and six sources; no T0/T1 trim', () => {
  const entries = Array.from({ length: 10 }, (_, i) => item(`source-${i}`, `explicit-${i}`));
  assert.equal(selectMemoryCueCapacity(entries).selected.length, 6);
  assert.equal(
    selectMemoryCueCapacity([item('large-a', undefined, undefined, 600), item('large-b', undefined, undefined, 600)])
      .selected.length,
    1,
  );
  const authority = item('authority');
  authority.envelope.candidate.sourceTier = 'T0';
  authority.promptSegment = 'token '.repeat(10000);
  assert.ok(selectMemoryCueCapacity([...entries, authority]).selected.includes(authority));
});
test('canonical duplicate wins by fixed priority independent of seed arrival order', () => {
  const old = item('same', 'project_source_required'),
    context = item('same');
  const primer = item('primer', 'fresh_context_sources', 'profile');
  const overview = item('overview', 'thread_opened', 'thread_overview');
  const chosen = selectMemoryCueCapacity([overview, context, primer, old]);
  assert.deepEqual(chosen.selected, [old, primer, overview]);
  assert.deepEqual(chosen.omitted, [context]);
});
test('source change after reservation fails final fence, release allows same source retry', async () => {
  const selected = item('revision');
  let valid = true;
  selected.envelope.validateCurrent = async () => valid;
  const ledger = new PresentationLedger(new InMemoryPresentationLedgerStore());
  const options = {
    envelopes: [selected.envelope],
    ledger,
    scope: { scopeKey: 'owner::cat::thread', contextEpoch: 1 },
    opportunityContext: {
      ownerUserId: 'owner',
      threadId: 'thread',
      invocationId: 'invocation',
      consumerCatId: 'cat',
      surface: 'dynamic_context',
      now: Date.now(),
    },
    buildEffectivePrompt: (segments) => ['base', ...segments].join('\n'),
  };
  const first = await prepareProviderPresentationAttempt(options);
  assert.equal(first.admitted.length, 1);
  valid = false;
  assert.equal(await first.revalidate(), false);
  await first.release('source_corrected');
  const omitted = await prepareProviderPresentationAttempt(options);
  assert.equal(omitted.admitted.length, 0);
  assert.equal(omitted.effectivePrompt, 'base');
  valid = true;
  const retry = await prepareProviderPresentationAttempt(options);
  assert.equal(retry.admitted.length, 1);
  await retry.release('test');
});
test('I/O budget bounds ignored aborts and does not count time between operations', async () => {
  const budget = new ContextSourceWorkBudget(30);
  assert.equal(await budget.run(async () => 'first'), 'first');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(await budget.run(async () => 'second'), 'second');
  await assert.rejects(
    budget.run(() => new Promise(() => {})),
    /context_source_timeout/,
  );
  await assert.rejects(
    budget.run(async () => 'late'),
    /context_source_timeout/,
  );
});

test('an exhausted discovery budget is a timeout, not evidence of an unavailable source', async () => {
  const omissions = [];
  const plane = new MemoryCuePlaneService({ get: () => ({ resolve: async () => [] }) });
  const scope = { ownerUserId: 'owner', threadId: 'thread', invocationId: 'invocation' };
  const result = await plane.resolve({
    candidate: {
      v: 1,
      kind: 'fresh_context_sources',
      producer: 'context_epoch',
      consumer: 'agent_route',
      opportunityId: 'timed-out-opportunity',
      scope,
      occurredAt: 1000,
      payload: {
        sourceMessageId: 'source',
        contextEpoch: 1,
        evidence: { transition: 'fresh', reason: 'no_prior_session', evidenceRef: 'native' },
      },
    },
    serverScope: scope,
    now: 1000,
    consumerCatId: 'cat',
    invocationState: { seenDedupeKeys: new Set() },
    contextSourceBudget: new ContextSourceWorkBudget(1),
    createDrillHandle: () => 'unused',
    recordOmission: (reason) => omissions.push(reason),
  });
  assert.equal(result.cues.length, 0);
  assert.ok(omissions.length > 0);
  assert.ok(
    omissions.every((reason) => reason === 'timeout'),
    JSON.stringify(omissions),
  );
});

test('invalid sources cannot starve a valid lane or add a second inaccurate omission', async () => {
  const omissions = [];
  const invalid = Array.from({ length: 6 }, (_, i) => {
    const selected = item(`stale-${i}`, 'project_source_required');
    selected.envelope.validateCurrent = async () => {
      omissions.push('source_corrected');
      return false;
    };
    selected.envelope.recordOmission = (reason) => omissions.push(reason);
    return selected.envelope;
  });
  const valid = item('current-primer', 'fresh_context_sources', 'profile').envelope;
  valid.validateCurrent = async () => true;
  const attempt = await prepareProviderPresentationAttempt({
    envelopes: [...invalid, valid],
    ledger: new PresentationLedger(new InMemoryPresentationLedgerStore()),
    scope: { scopeKey: 'owner::cat::thread', contextEpoch: 1 },
    opportunityContext: {
      ownerUserId: 'owner',
      threadId: 'thread',
      invocationId: 'invocation',
      consumerCatId: 'cat',
      surface: 'dynamic_context',
      now: Date.now(),
    },
    buildEffectivePrompt: (segments) => segments.join('\n'),
  });
  assert.deepEqual(
    attempt.admitted.map((e) => e.envelope),
    [valid],
  );
  assert.deepEqual(omissions, Array(6).fill('source_corrected'));
  await attempt.release('test');
});
