import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../helpers/setup-cat-registry.js';
import { fileURLToPath } from 'node:url';
import { TaskStore } from '../../src/domains/cats/services/stores/ports/TaskStore.js';
import { DevelopmentScopeGitDocuments } from '../../src/domains/growing/DevelopmentScopeGitDocuments.js';
import { DevelopmentScopeResolver } from '../../src/domains/growing/DevelopmentScopeResolver.js';

const feature = {
  ref: 'file:docs/features/F310-growing-real-delegation.md',
  content: '---\nfeature_ids: [F310]\n---\n### Phase B — First loop\naccepted',
};
const docs = { readFeature: async () => feature, readPlan: async () => '<a id="accepted-unit"></a>\naccepted work' };
const actor = { userId: 'user-a', threadId: 'thread-a', catId: 'codex-sol' };
const query = { featureRef: 'feature:F310', phaseKey: 'B', acceptedRevision: 'a'.repeat(40) };

test('the accepted F310 source resolves its implementation Phase, separately from repeated AC headings', async () => {
  const committedDocs = new DevelopmentScopeGitDocuments(fileURLToPath(new URL('../../../..', import.meta.url)));
  const resolver = new DevelopmentScopeResolver(new TaskStore(), committedDocs);
  const result = await resolver.resolve(actor, {
    ...query,
    acceptedRevision: '09df55f01b5a9f0c89962baff68a39e0df050a86',
  });
  assert.equal(result.result, 'resolved');
});

test('fresh cats resolve the same canonical Phase key without messages or cat IDs in identity', async () => {
  const resolver = new DevelopmentScopeResolver(new TaskStore(), docs);
  const first = await resolver.resolve(actor, query);
  const second = await resolver.resolve({ ...actor, catId: 'opus' }, query);
  assert.equal(first.result, 'resolved');
  assert.deepEqual(first.scope, second.scope);
  assert.equal(first.scope.workUnitRef, 'feature-phase:F310:B');
});

test('missing Phase declarations cannot mint identities; repeated headings preserve the same key', async () => {
  for (const [content, expected] of [
    ['### Phase C — Later', 'scope_invalid'],
    [`${feature.content}\n### Phase B — Further detail`, 'resolved'],
  ]) {
    const resolver = new DevelopmentScopeResolver(new TaskStore(), {
      ...docs,
      readFeature: async () => ({ ...feature, content }),
    });
    assert.equal((await resolver.resolve(actor, query)).result, expected);
  }
});

test('existing same-thread open sub-work wins before a new default ref is considered', async () => {
  const store = new TaskStore();
  const scope = {
    ...query,
    workUnitRef: 'file:docs/plans/accepted.md#accepted-unit',
    acceptedSourceRef: 'file:docs/plans/accepted.md#accepted-unit',
  };
  const first = await store.transitionDevelopmentWork({
    action: 'admit',
    actor,
    scope,
    sourceRef: 'message:first',
    sourceRevision: `sha256:${'a'.repeat(64)}`,
    idempotencyKey: 'first',
    contract: {
      revision: 1,
      admission: {
        basis: 'explicit_entrustment',
        sourceRefs: ['message:first'],
        idempotencyKey: 'first',
        receiptRef: 'task:receipt:first',
        admittedAt: 1,
      },
      intendedOutcome: 'Accepted child',
      time: {},
      artifactRefs: [],
      closure: { state: 'open', condition: 'Verified', expectedSignal: 'verified', evidenceRefs: [] },
    },
  });
  assert.ok('task' in first);
  const resolver = new DevelopmentScopeResolver(store, docs);
  const resolved = await resolver.resolve(actor, query);
  assert.equal(resolved.result, 'resolved');
  assert.equal(resolved.scope.workUnitRef, scope.workUnitRef);
  assert.equal(resolved.existing.taskRef, `task:work:${first.task.id}`);
  assert.deepEqual(
    await resolver.resolve({ ...actor, threadId: 'foreign' }, { ...query, workUnitRef: scope.workUnitRef }),
    { result: 'scope_unavailable_here' },
  );
});

test('an arbitrary plan anchor or free-text work unit is rejected', async () => {
  const resolver = new DevelopmentScopeResolver(new TaskStore(), docs);
  assert.equal(
    (await resolver.resolve(actor, { ...query, workUnitRef: 'file:docs/plans/accepted.md#missing' })).result,
    'scope_invalid',
  );
  await assert.rejects(resolver.resolve(actor, { ...query, workUnitRef: 'make-something-up' }));
});
