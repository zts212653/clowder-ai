import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionSuccessorAdmissionService } from '../dist/domains/ball-custody/ActionSuccessorAdmissionService.js';
import { ActionSuccessorCompletionService } from '../dist/domains/ball-custody/ActionSuccessorCompletionService.js';
import { canonicalizeActionTerminalPredicate } from '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import { bindActionCompletionVerdict } from '../dist/domains/ball-custody/action-successor-completion-state-machine.js';
import {
  claimActionSuccessor,
  commitActionCompletionVerdict,
  recordActionCompletionCandidate,
} from '../dist/domains/ball-custody/action-successor-state-machine.js';

const binding = {
  pluginInstanceId: 'installation-1',
  packageDigest: 'b'.repeat(64),
  featureId: 'review',
  contributionId: 'review-truth',
  freshnessMethod: 'review.freshness',
  completionMethod: 'review.completion',
  grantRevision: 3,
  lifecycleRevision: 4,
  tenantScope: 'owner',
  installationProjectRoot: '/isolated/project',
};
const request = () => ({
  tenantScope: 'owner',
  actorCatId: 'author',
  sourceThreadId: 'source',
  targetThreadId: 'target',
  holderCatIds: ['reviewer'],
  dispatchId: 'dispatch',
  evidenceRef: 'message:request',
  now: 100,
  action: {
    subjectRef: 'pr:owner/repo#42',
    actionFamily: 'review',
    successorSlot: 'reviewer',
    mode: 'single',
    terminalPredicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
  },
});
const predicate = canonicalizeActionTerminalPredicate({
  ...request().action,
  predicate: request().action.terminalPredicate,
});
const lease = () =>
  claimActionSuccessor(null, {
    ...request(),
    ...request().action,
    leaseId: 'lease-1',
    holderThreadId: 'target',
    claimOrigin: 'structured_transfer',
    predecessorCatId: 'author',
    predecessorThreadId: 'source',
    issuerStandingEvidenceRef: 'message:request',
    evidenceRefs: ['message:request'],
    terminalPredicate: predicate,
    terminalPredicateProviderBinding: binding,
  }).lease;

function admission({ route = 'claim', revoke = false, override = false } = {}) {
  const calls = { contexts: [], writes: [], guards: 0 };
  let guarded = false;
  const current = lease();
  const completed = {
    ...current,
    status: 'completed',
    terminalPredicate: canonicalizeActionTerminalPredicate({
      ...request().action,
      predicate: { kind: 'review_delivered', headSha: 'c'.repeat(40) },
    }),
  };
  const freshness = {
    status: 'verified',
    evidenceRef: 'provider:head',
    freshnessKey: predicate.freshnessKey,
    ownerCatId: 'reviewer',
    holderThreadId: 'target',
    tenantScope: 'owner',
    providerAuthority: {
      binding,
      async withAuthority(write) {
        calls.guards++;
        if (revoke) throw Error('provider authority revoked');
        guarded = true;
        try {
          return await write();
        } finally {
          guarded = false;
        }
      },
    },
  };
  const capture = (input) => calls.writes.push({ input, guarded });
  const store = {
    async get() {
      return current;
    },
    async claim(input) {
      capture(input);
      return route === 'fresh' ? { outcome: 'safe_wait', lease: completed } : { outcome: 'claimed', lease: current };
    },
    async replace(_id, input) {
      capture(input);
      return { outcome: 'replaced', lease: current };
    },
    async continueFreshRevision(_id, input) {
      capture(input);
      return { outcome: 'continued', lease: current };
    },
  };
  const service = new ActionSuccessorAdmissionService(store, {
    async resolve() {
      return { terminal: false, source: 'unsupported', state: 'unknown' };
    },
    async resolveFreshness(_predicate, context) {
      calls.contexts.push(context);
      return freshness;
    },
  });
  const input = request();
  if (route === 'replace') input.action.replace = { leaseId: current.leaseId, expectedGeneration: 1 };
  const options = override
    ? {
        claim: async (value) => {
          capture(value);
          return { outcome: 'claimed', lease: current };
        },
      }
    : undefined;
  return { calls, run: () => service.admit(input, options) };
}

test('freshness receives the actual admission actor and source, distinct from the proposed holder', async () => {
  const h = admission();
  await h.run();
  assert.deepEqual(h.calls.contexts[0], {
    tenantScope: 'owner',
    actorCatId: 'author',
    sourceThreadId: 'source',
    targetThreadId: 'target',
    holderCatIds: ['reviewer'],
  });
});
for (const route of ['claim', 'replace', 'fresh']) {
  test(`${route} persists exactly the verified installation binding inside its authority guard`, async () => {
    const h = admission({ route });
    await h.run();
    assert.ok(h.calls.writes.length > 0);
    for (const write of h.calls.writes) {
      assert.deepEqual(write.input.terminalPredicateProviderBinding, binding);
      assert.equal(write.guarded, true, 'lease write escaped authority guard');
      assert.equal(
        Object.hasOwn(write.input, 'providerAuthority'),
        false,
        'internal closure must not enter durable lease',
      );
    }
  });
}
test('an atomic claim override still executes inside the provider authority guard', async () => {
  const h = admission({ override: true });
  await h.run();
  assert.equal(h.calls.writes[0].guarded, true);
});
test('revocation after freshness prevents any lease write', async () => {
  const h = admission({ revoke: true });
  await assert.rejects(h.run, /provider authority revoked/);
  assert.equal(h.calls.writes.length, 0);
});

function completion({ replay = false, deny = false, revokeAfterRead = false, noAuthority = false } = {}) {
  let current = lease();
  const input = {
    leaseId: current.leaseId,
    generation: 1,
    catId: 'reviewer',
    evidenceRefs: ['github:https://github.com/owner/repo/pull/42#pullrequestreview-123'],
    now: 110,
  };
  const verdict = (candidate) =>
    bindActionCompletionVerdict(
      {
        status: 'verified',
        evidenceRef: 'github:https://github.com/owner/repo/pull/42#pullrequestreview-123',
        predicateDigest: predicate.digest,
        freshnessKey: predicate.freshnessKey,
      },
      candidate,
    );
  if (replay) {
    current = recordActionCompletionCandidate(current, input);
    current = commitActionCompletionVerdict(current, {
      ...input,
      verdict: verdict(current.completionCandidates.reviewer),
    });
  }
  const calls = { authorization: 0, writes: [], providerReads: 0, genericReads: 0 };
  let guarded = false;
  let revoked = false;
  const store = {
    async get() {
      return current;
    },
    async recordCompletionCandidate(_id, candidate) {
      calls.writes.push({ kind: 'candidate', guarded });
      current = recordActionCompletionCandidate(current, candidate);
      return { outcome: 'recorded', lease: current };
    },
    async commitCompletionVerdict(_id, result) {
      calls.writes.push({ kind: 'verdict', guarded });
      current = commitActionCompletionVerdict(current, result);
      return { outcome: 'committed', lease: current };
    },
  };
  const resolver = {
    async resolveCompletion(_predicate, candidate) {
      calls.genericReads++;
      return verdict(candidate);
    },
    ...(!noAuthority
      ? {
          async authorizeCompletion(observed, actor) {
            calls.authorization++;
            assert.deepEqual(observed.terminalPredicateProviderBinding, binding);
            assert.equal(actor.catId, 'reviewer');
            if (deny) return { status: 'insufficient', reason: 'native invocation unavailable' };
            return {
              status: 'authorized',
              async withAuthority(write) {
                if (revoked) throw Error('provider authority revoked');
                guarded = true;
                try {
                  return await write();
                } finally {
                  guarded = false;
                }
              },
              async resolveCompletion(_predicate, candidate) {
                assert.equal(guarded, false, 'provider IO must be outside inventory lock');
                calls.providerReads++;
                if (revokeAfterRead) revoked = true;
                return verdict(candidate);
              },
            };
          },
        }
      : {}),
  };
  return { calls, run: () => new ActionSuccessorCompletionService(store, resolver).complete(input) };
}
test('a persisted success replay cannot bypass current native caller authorization', async () => {
  const h = completion({ replay: true, deny: true });
  assert.deepEqual(await h.run(), { outcome: 'insufficient', reason: 'native invocation unavailable' });
  assert.equal(h.calls.authorization, 1);
  assert.equal(h.calls.writes.length, 0);
});
test('a bound lease fails closed when no completion authority port exists', async () => {
  const h = completion({ noAuthority: true });
  const result = await h.run();
  assert.equal(result.outcome, 'insufficient');
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.calls.genericReads, 0);
});
test('candidate and success CAS are guarded, while provider IO is independently read outside the guard', async () => {
  const h = completion();
  assert.equal((await h.run()).outcome, 'committed');
  assert.equal(h.calls.authorization, 1);
  assert.equal(h.calls.providerReads, 1);
  assert.equal(h.calls.genericReads, 0);
  assert.deepEqual(h.calls.writes, [
    { kind: 'candidate', guarded: true },
    { kind: 'verdict', guarded: true },
  ]);
});
test('revocation during provider IO prevents completion CAS', async () => {
  const h = completion({ revokeAfterRead: true });
  await assert.rejects(h.run, /provider authority revoked/);
  assert.deepEqual(h.calls.writes, [{ kind: 'candidate', guarded: true }]);
});
