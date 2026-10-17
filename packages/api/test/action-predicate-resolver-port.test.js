import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionSubjectTruthResolver } from '../dist/domains/ball-custody/ActionSubjectTruthResolver.js';
import { canonicalizeActionTerminalPredicate } from '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';

const predicate = canonicalizeActionTerminalPredicate({
  actionFamily: 'review',
  subjectRef: 'pr:owner/repo#42',
  predicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
});
const context = {
  tenantScope: 'owner',
  actorCatId: 'author',
  sourceThreadId: 'source',
  targetThreadId: 'target',
  holderCatIds: ['reviewer'],
};

test('neutral resolver dispatches review freshness only with explicit admission context', async () => {
  const calls = [];
  const resolver = new ActionSubjectTruthResolver({}, undefined, undefined, {
    async resolveFreshness(p, c) {
      calls.push([p, c]);
      return { status: 'insufficient', reason: 'provider fact unavailable' };
    },
  });
  assert.equal((await resolver.resolveFreshness(predicate)).status, 'insufficient');
  assert.equal(calls.length, 0);
  assert.deepEqual(await resolver.resolveFreshness(predicate, context), {
    status: 'insufficient',
    reason: 'provider fact unavailable',
  });
  assert.deepEqual(calls, [[predicate, context]]);
});

test('neutral resolver delegates bound completion and refuses a legacy unbound lease', async () => {
  const calls = [];
  const resolver = new ActionSubjectTruthResolver({}, undefined, undefined, {
    async authorizeCompletion(lease, actor) {
      calls.push([lease, actor]);
      return { status: 'insufficient', reason: 'native context unavailable' };
    },
  });
  assert.equal(typeof resolver.authorizeCompletion, 'function', 'Host completion authority entry missing');
  const lease = { terminalPredicate: predicate, terminalPredicateProviderBinding: { pluginInstanceId: 'instance' } };
  assert.deepEqual(await resolver.authorizeCompletion(lease, { catId: 'reviewer' }), {
    status: 'insufficient',
    reason: 'native context unavailable',
  });
  assert.equal(
    (await resolver.authorizeCompletion({ terminalPredicate: predicate }, { catId: 'reviewer' })).status,
    'insufficient',
  );
  assert.deepEqual(calls, [[lease, { catId: 'reviewer' }]]);
});

test('a plugin provider cannot replace the task freshness resolver', async () => {
  const p = canonicalizeActionTerminalPredicate({
    actionFamily: 'implement',
    subjectRef: 'subject:task:work-1',
    predicate: { kind: 'task_done' },
  });
  let calls = 0;
  const resolver = new ActionSubjectTruthResolver(
    {},
    {
      async get() {
        return {
          id: 'work-1',
          status: 'doing',
          userId: 'owner',
          ownerCatId: 'reviewer',
          threadId: 'target',
          updatedAt: 10,
        };
      },
    },
    undefined,
    {
      async resolveFreshness() {
        calls++;
        throw Error('plugin must not be consulted');
      },
    },
  );
  const result = await resolver.resolveFreshness(p, context);
  assert.equal(result.status, 'verified');
  assert.equal(result.evidenceRef, 'task:work-1:active:10');
  assert.equal(result.providerAuthority, undefined);
  assert.equal(calls, 0);
});
