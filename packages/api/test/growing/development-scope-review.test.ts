import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import '../helpers/setup-cat-registry.js';
import { TaskStore } from '../../src/domains/cats/services/stores/ports/TaskStore.js';
import { DevelopmentScopeGitDocuments } from '../../src/domains/growing/DevelopmentScopeGitDocuments.js';
import { DevelopmentScopeResolver } from '../../src/domains/growing/DevelopmentScopeResolver.js';

const actor = { userId: 'human', threadId: 'original', catId: 'codex-sol' };
const query = { featureRef: 'feature:F310', phaseKey: 'B', acceptedRevision: 'a'.repeat(40) };
const docs = {
  readFeature: async () => ({ ref: 'file:docs/features/F310-growing.md', content: '### Phase B — Accepted' }),
  readPlan: async () => '<a id="unit"></a>',
};
function admit(store, owner, ref, parentTaskRef?) {
  return store.transitionDevelopmentWork({
    action: 'admit',
    actor: owner,
    scope: { ...query, workUnitRef: ref, acceptedSourceRef: 'file:docs/features/F310-growing.md' },
    sourceRef: `message:${ref}`,
    sourceRevision: `sha256:${'a'.repeat(64)}`,
    idempotencyKey: ref,
    ...(parentTaskRef ? { parentTaskRef } : {}),
    contract: {
      revision: 1,
      admission: {
        basis: 'explicit_entrustment',
        sourceRefs: [`message:${ref}`],
        idempotencyKey: ref,
        receiptRef: 'task:receipt:first',
        admittedAt: 1,
      },
      intendedOutcome: 'Accepted development',
      time: {},
      artifactRefs: [],
      closure: { state: 'open', condition: 'Verified', expectedSignal: 'verified', evidenceRefs: [] },
    },
  });
}

test('Phase owner resumes its parent in the same thread as another cat’s child', async () => {
  const store = new TaskStore();
  const parent = admit(store, actor, 'feature-phase:F310:B');
  assert.ok('task' in parent);
  const child = admit(
    store,
    { ...actor, catId: 'codex-astra' },
    'file:docs/plans/accepted.md#unit',
    `task:work:${parent.task.id}`,
  );
  assert.ok('task' in child);
  const result = await new DevelopmentScopeResolver(store, docs).resolve(actor, query);
  assert.equal(result.result, 'resolved');
  assert.equal(result.existing.taskRef, `task:work:${parent.task.id}`);
});

test('an owner can explicitly choose its Phase instead of its own open sub-work', async () => {
  const store = new TaskStore();
  const parent = admit(store, actor, 'feature-phase:F310:B');
  admit(store, actor, 'file:docs/plans/accepted.md#unit', `task:work:${parent.task.id}`);
  const resolver = new DevelopmentScopeResolver(store, docs);
  assert.equal((await resolver.resolve(actor, query)).scope.workUnitRef, 'file:docs/plans/accepted.md#unit');
  const result = await resolver.resolve(actor, { ...query, workUnitRef: 'feature-phase:F310:B' });
  assert.equal(result.result, 'resolved');
  assert.equal(result.existing.taskRef, `task:work:${parent.task.id}`);
  await assert.rejects(resolver.resolve(actor, { ...query, workUnitRef: 'feature-phase:F310:C' }));
});

for (const [phaseKey, heading] of [
  ['B', 'Phase B：说明'],
  ['B', 'Phase B ✅'],
  ['B', 'Phase B（说明）'],
  ['B', 'Phase B (accepted)'],
  ['1', 'Phase 1 — Accepted'],
  ['1.5', 'Phase 1.5: Accepted'],
  ['1b', 'Phase 1b: Accepted'],
  ['B1', 'Phase B1 — Accepted'],
  ['B', 'Phase B 第一批执行结果'],
  ['1', 'Phase 1 回顾 (已合入)'],
  ['2', 'Phase 2 Spec (rewrite)'],
  ['B', 'Phase B\tDelivery'],
  ['B-foo', 'Phase B-foo Delivery'],
]) {
  test(`resolves canonical declaration ${heading}`, async () => {
    const resolver = new DevelopmentScopeResolver(new TaskStore(), {
      ...docs,
      readFeature: async () => ({ ref: 'file:docs/features/F310-growing.md', content: `### ${heading}` }),
    });
    const result = await resolver.resolve(actor, { ...query, phaseKey });
    assert.equal(result.result, 'resolved');
    assert.equal(result.scope.workUnitRef, `feature-phase:F310:${phaseKey}`);
  });
}

test('prefixes, prose, and fenced examples cannot declare the requested Phase', async () => {
  for (const content of [
    '### Phase Bfoo',
    '### Phase Bfoo Delivery',
    '### Phase B-foo Delivery',
    'Phase B Delivery',
    '### Status of Phase B Delivery',
    '```markdown\n### Phase B Delivery\n```',
    '~~~markdown\n### Phase B Delivery\n~~~',
  ]) {
    const resolver = new DevelopmentScopeResolver(new TaskStore(), {
      ...docs,
      readFeature: async () => ({ ref: 'file:docs/features/F310-growing.md', content }),
    });
    assert.equal((await resolver.resolve(actor, query)).result, 'scope_invalid', content);
  }
});

test('real F079 whitespace-titled declarations resolve without another punctuated heading', async () => {
  const documents = new DevelopmentScopeGitDocuments(fileURLToPath(new URL('../../../..', import.meta.url)));
  const resolver = new DevelopmentScopeResolver(new TaskStore(), documents);
  for (const phaseKey of ['1', '2']) {
    const result = await resolver.resolve(actor, {
      featureRef: 'feature:F079',
      phaseKey,
      acceptedRevision: '9eb913340e4d6390a4846273436050c6f330ae73',
    });
    assert.equal(result.result, 'resolved', phaseKey);
    assert.equal(result.scope.workUnitRef, `feature-phase:F079:${phaseKey}`);
  }
});

test('nested canonical F061 sub-phases are declared regardless of heading depth', async () => {
  const documents = new DevelopmentScopeGitDocuments(fileURLToPath(new URL('../../../..', import.meta.url)));
  const resolver = new DevelopmentScopeResolver(new TaskStore(), documents);
  for (const phaseKey of ['2c-R', '2c-D', '2c-I']) {
    const result = await resolver.resolve(actor, {
      featureRef: 'feature:F061',
      phaseKey,
      acceptedRevision: '9eb913340e4d6390a4846273436050c6f330ae73',
    });
    assert.equal(result.result, 'resolved', phaseKey);
    assert.equal(result.scope.workUnitRef, `feature-phase:F061:${phaseKey}`);
  }
});

for (const code of ['ETIMEDOUT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'ENOENT']) {
  test(`git ${code} is retryable uncertainty, not an invalid scope`, async () => {
    const documents = new DevelopmentScopeGitDocuments('/unused', async () => {
      throw Object.assign(new Error('git failed'), { code });
    });
    const result = await new DevelopmentScopeResolver(new TaskStore(), documents).resolve(actor, query);
    assert.deepEqual(result, { result: 'scope_unverifiable', retryable: true });
  });
}

test('real committed numeric Phase source resolves; proven missing files remain invalid', async () => {
  const documents = new DevelopmentScopeGitDocuments(fileURLToPath(new URL('../../../..', import.meta.url)));
  const resolver = new DevelopmentScopeResolver(new TaskStore(), documents);
  const revision = '80f2216855f1ad4fd7c31e630dc052eee4943d83';
  const result = await resolver.resolve(actor, {
    featureRef: 'feature:F054',
    phaseKey: '1.5',
    acceptedRevision: revision,
  });
  assert.equal(result.result, 'resolved');
  assert.equal(result.scope.workUnitRef, 'feature-phase:F054:1.5');
  const integer = await resolver.resolve(actor, {
    featureRef: 'feature:F050',
    phaseKey: '1',
    acceptedRevision: revision,
  });
  assert.equal(integer.result, 'resolved');
  assert.equal(integer.scope.workUnitRef, 'feature-phase:F050:1');
  assert.equal(
    (await resolver.resolve(actor, { ...query, featureRef: 'feature:F999999', acceptedRevision: revision })).result,
    'scope_invalid',
  );
  assert.equal(await documents.readPlan('file:docs/plans/no-such-plan.md#none', revision), null);
});

for (const [featureId, phaseKey] of [
  ['F093', 'A+'],
  ['F101', 'H1+H2'],
  ['F032', 'C/D'],
  ['F102', 'F-1/F-2/F-3'],
  ['F129', 'B-α'],
  ['F300', "2'"],
  ['F048', 'A'],
  ['F169', 'A'],
]) {
  test(`declared repository Phase ${featureId}/${phaseKey} survives the entire scope grammar`, async () => {
    const documents = new DevelopmentScopeGitDocuments(fileURLToPath(new URL('../../../..', import.meta.url)));
    const result = await new DevelopmentScopeResolver(new TaskStore(), documents).resolve(actor, {
      featureRef: `feature:${featureId}`,
      phaseKey,
      acceptedRevision: 'dbbf85e71ef1788050d1a52f7474698b9bbc31b6',
    });
    assert.equal(result.result, 'resolved');
    assert.equal(result.scope.workUnitRef, `feature-phase:${featureId}:${phaseKey}`);
  });
}

test('AC-only and repeated AC declarations identify the same Phase', async () => {
  for (const [content, expected] of [
    ['## Acceptance Criteria\n### Phase B：Accepted', 'resolved'],
    ['## Acceptance Criteria\n### Phase B：First\n### Phase B：Second', 'resolved'],
  ]) {
    const resolver = new DevelopmentScopeResolver(new TaskStore(), {
      ...docs,
      readFeature: async () => ({ ref: 'file:docs/features/F310-growing.md', content }),
    });
    assert.equal((await resolver.resolve(actor, query)).result, expected);
  }
});

for (const [featureId, phaseKey] of [
  ['F100', '2'],
  ['F101', 'F'],
]) {
  test(`repeated canonical headings preserve one Phase identity ${featureId}/${phaseKey}`, async () => {
    const docs = new DevelopmentScopeGitDocuments(fileURLToPath(new URL('../../../..', import.meta.url)));
    const result = await new DevelopmentScopeResolver(new TaskStore(), docs).resolve(actor, {
      featureRef: `feature:${featureId}`,
      phaseKey,
      acceptedRevision: '23637ff1d70734a5cf4d928c0c3c96136ab1285f',
    });
    assert.equal(result.result, 'resolved');
    assert.equal(result.scope.workUnitRef, `feature-phase:${featureId}:${phaseKey}`);
  });
}

test('the actual F310 Unicode plan anchor survives both query and accepted source contracts', async () => {
  const docs = new DevelopmentScopeGitDocuments(fileURLToPath(new URL('../../../..', import.meta.url)));
  const ref = 'file:docs/plans/2026-08-31-f310-phase-b-first-real-loop.md#95-新执行-thread-的责任与交接';
  const result = await new DevelopmentScopeResolver(new TaskStore(), docs).resolve(actor, {
    ...query,
    acceptedRevision: '23637ff1d70734a5cf4d928c0c3c96136ab1285f',
    workUnitRef: ref,
  });
  assert.equal(result.result, 'resolved');
  assert.equal(result.scope.workUnitRef, ref);
  assert.equal(result.scope.acceptedSourceRef, ref);
});

test('a real dotted plan filename is addressable without allowing traversal or missing anchors', async () => {
  const docs = new DevelopmentScopeGitDocuments(fileURLToPath(new URL('../../../..', import.meta.url)));
  const revision = '23637ff1d70734a5cf4d928c0c3c96136ab1285f';
  const ref = 'file:docs/plans/2026-03-28-f056-phase-a2.5-neutral-codemod.md#mapping-table';
  assert.ok(await docs.readPlan(ref, revision));
  const resolver = new DevelopmentScopeResolver(new TaskStore(), docs);
  await assert.rejects(resolver.resolve(actor, { ...query, workUnitRef: 'file:docs/plans/../secret.md#x' }));
  const absent = await resolver.resolve(actor, {
    ...query,
    acceptedRevision: revision,
    workUnitRef: 'file:docs/plans/2026-08-31-f310-phase-b-first-real-loop.md#不存在的锚点',
  });
  assert.equal(absent.result, 'scope_invalid');
});

test('a plan heading inside a fenced example cannot supply a persistent work anchor', async () => {
  const resolver = new DevelopmentScopeResolver(new TaskStore(), {
    ...docs,
    readPlan: async () => '```markdown\n## 示例工作\n```',
  });
  const result = await resolver.resolve(actor, { ...query, workUnitRef: 'file:docs/plans/accepted.md#示例工作' });
  assert.equal(result.result, 'scope_invalid');
});
