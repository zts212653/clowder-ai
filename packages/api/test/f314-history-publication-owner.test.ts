import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { evolutionExplorationReviewV1Schema, refIdentity } from '@cat-cafe/shared';
import { HarnessHistorySourceError } from '../src/infrastructure/capability-evolution/adapters/request-review/harness-history-git-source.js';
import { HarnessHistoryPublicationOwner } from '../src/infrastructure/capability-evolution/adapters/request-review/harness-history-publication-owner.js';
import { MemoryHarnessHistoryPublicationStore } from '../src/infrastructure/capability-evolution/adapters/request-review/harness-history-publication-store.js';
import { f314HistoryV3Fixture } from './helpers/f314-history-v3-fixture.js';

const archive = JSON.parse(
  readFileSync(
    new URL('../../shared/src/__tests__/fixtures/f314-history-publication-contract.json', import.meta.url),
    'utf8',
  ),
);
const input = {
  programRef: { ownerFeatureId: 'F311', ownerStateRef: `evolution-program:${'1'.repeat(32)}` },
  objectRef: { ownerFeatureId: 'F100', ownerStateRef: 'capability:development-process-harness-effectiveness' },
};
const actor = { actorRef: 'cat:codex-astra', originRef: 'thread:fixture:invocation:writer' };
const a = 'a'.repeat(40),
  b = 'b'.repeat(40),
  c = 'c'.repeat(40),
  d = 'd'.repeat(40);
function fixture() {
  const next = structuredClone(archive);
  next.story.nodes[0].summary = '新补的后续结果';
  const store = new MemoryHarnessHistoryPublicationStore();
  const source = {
    baseline: async () => a,
    read: async (revision: string) => (revision === b ? next : archive),
    acquire: async (revision: string) => {
      if (revision === c) throw new HarnessHistorySourceError('source_unavailable');
      return revision === b ? next : archive;
    },
  };
  return { store, source, owner: new HarnessHistoryPublicationOwner({ store, source }), next };
}
const publish = (revision: number, sourceRevision = b, clientMessageId = `publish-${revision}`) => ({
  action: 'publish' as const,
  expectedRevision: revision,
  sourceRevision,
  clientMessageId,
  reason: '补上有来源的后续结果',
});

test('same running owner publishes B, exact A remains A, failed publication preserves B, restore appends and replay preserves the original receipt', async () => {
  const { owner, store, source } = fixture();
  const initial = await owner.read(input);
  assert.equal(initial.status, 'resolved');
  if (initial.status !== 'resolved') return;
  const selected = { ...input, selectedSourceRef: initial.sourceRef, selectedNodeRef: initial.nodes[0].nodeRef };
  assert.equal((await owner.publish(input, publish(0), actor)).outcome, 'appended');
  const current = await owner.read(input);
  assert.equal(current.status, 'resolved');
  if (current.status !== 'resolved') return;
  assert.equal(current.nodes[0].summary, '新补的后续结果');
  assert.notEqual(refIdentity(initial.sourceRef), refIdentity(current.sourceRef));
  const old = await owner.read(selected);
  assert.equal(old.status, 'resolved');
  if (old.status !== 'resolved') return;
  assert.equal(old.nodes[0].summary, initial.nodes[0].summary);
  assert.equal(old.publication?.selectionUpdate?.kind, 'modified');
  assert.equal(evolutionExplorationReviewV1Schema.safeParse(old).success, true);
  const failed = await owner.publish(input, publish(1, c), actor);
  assert.equal('attempt' in failed && failed.attempt.status, 'failed');
  assert.equal((await owner.status(input)).current.revision, 1);
  const restore = await owner.publish(
    input,
    {
      action: 'restore',
      expectedRevision: 2,
      restoreRevision: 0,
      clientMessageId: 'restore',
      reason: '退回上一份完整稿',
    },
    actor,
  );
  assert.equal('attempt' in restore && restore.attempt.revision, 3);
  const rebuilt = new HarnessHistoryPublicationOwner({ store, source });
  const restored = await rebuilt.read(input);
  assert.equal(restored.status, 'resolved');
  if (restored.status !== 'resolved') return;
  assert.equal(restored.nodes[0].summary, initial.nodes[0].summary);
  assert.equal(restored.publication?.current.revision, 3);
  const replay = await rebuilt.publish(input, publish(0), actor);
  assert.equal(replay.outcome, 'duplicate');
  assert.equal('attempt' in replay && replay.attempt.revision, 1);
  assert.equal((await rebuilt.status(input)).current.revision, 3);
  assert.equal(
    (await rebuilt.publish(input, { ...publish(0), reason: 'changed' }, actor)).outcome,
    'idempotency_collision',
  );
  assert.equal((await rebuilt.publish(input, publish(0, a, 'stale'), actor)).outcome, 'conflict');
});

test('competing publications append once; source refs cannot cross Program scope; old unversioned preferences receive explicit recovery', async () => {
  const { owner } = fixture();
  const attempts = await Promise.all([
    owner.publish(input, publish(0), actor),
    owner.publish(input, publish(0, a, 'other'), actor),
  ]);
  assert.deepEqual(attempts.map((result) => result.outcome).sort(), ['appended', 'conflict']);
  const current = await owner.status(input);
  await assert.rejects(
    () =>
      owner.read({
        ...input,
        programRef: { ...input.programRef, ownerStateRef: `evolution-program:${'2'.repeat(32)}` },
        selectedSourceRef: current.current.ref,
      }),
    { code: 'history_source_not_published' },
  );
  await assert.rejects(
    () => owner.read({ ...input, selectedSourceRef: { ...current.current.ref, version: `publication:99:${b}` } }),
    { code: 'history_source_not_published' },
  );
  const recovered = await owner.read({
    ...input,
    selectedNodeRef: { ownerFeatureId: 'F314', ownerStateRef: 'harness-history:release:H01', version: 'old' },
  });
  assert.equal(recovered.status, 'invalid');
  assert.equal(evolutionExplorationReviewV1Schema.safeParse(recovered).success, true);
  assert.deepEqual('recoverySelection' in recovered && recovered.recoverySelection, {
    selectedSourceRef: current.current.ref,
  });
});

async function assertSelectionUpdateAfterCaseChange(removal: boolean) {
  const { owner, next } = fixture();
  const initial = await owner.read(input);
  assert.equal(initial.status, 'resolved');
  if (initial.status !== 'resolved') return;
  const oldStep = next.story.nodes[0].id;
  const targetStep = next.story.nodes[1].id;
  const selectedCase = next.story.cases.find((entry: { nodeId: string }) => entry.nodeId === oldStep);
  assert.ok(selectedCase);
  const selectedExperiment = initial.experiments.find(
    (entry) => entry.experimentRef.ownerStateRef === `harness-history:case:${selectedCase.caseId}`,
  );
  assert.ok(selectedExperiment);
  const selection = {
    ...input,
    selectedSourceRef: initial.sourceRef,
    selectedNodeRef: selectedExperiment.nodeRef,
    selectedExperimentRef: selectedExperiment.experimentRef,
  };
  next.story.nodes = next.story.nodes.filter((entry: { id: string }) => entry.id !== oldStep);
  for (const node of next.story.nodes)
    node.parents = node.parents.filter((entry: { nodeId: string }) => entry.nodeId !== oldStep);
  for (const entry of next.story.cases) if (entry.nodeId === oldStep) entry.nodeId = targetStep;
  if (removal) {
    next.cases = next.cases.filter((entry: { caseId: string }) => entry.caseId !== selectedCase.caseId);
    next.story.cases = next.story.cases.filter((entry: { caseId: string }) => entry.caseId !== selectedCase.caseId);
  }
  const result = await owner.publish(input, publish(0), actor);
  assert.equal('attempt' in result && result.attempt.status, 'published');
  const old = await owner.read(selection);
  assert.equal(old.status, 'resolved');
  if (old.status !== 'resolved') return;
  const update = old.publication?.selectionUpdate;
  assert.equal(update?.kind, removal ? 'removed' : 'moved');
  assert.equal(old.details[0].status, 'resolved');
  if (removal) {
    assert.equal(update?.nextSelection, undefined);
    return;
  }
  assert.equal(update?.nextSelection?.selectedNodeRef?.ownerStateRef, `harness-history:story:${targetStep}`);
  const current = await owner.read({ ...input, ...update?.nextSelection });
  assert.equal(current.status, 'resolved');
  assert.equal(evolutionExplorationReviewV1Schema.safeParse(current).success, true);
}

test('a case moved out of a removed step maps to its new exact step; a removed case retains only the old reading', async () => {
  await assertSelectionUpdateAfterCaseChange(false);
  await assertSelectionUpdateAfterCaseChange(true);
});

test('changing only a parent relationship source requires explicit adoption', async () => {
  const before = f314HistoryV3Fixture(archive);
  before.story.sources.push({
    ...before.story.sources[0],
    id: 'other-evidence',
    label: '另一份已核来源',
  });
  const after = structuredClone(before);
  const child = after.story.steps.find((step) => step.parentEdges.length > 0);
  assert.ok(child);
  child.parentEdges[0].sourceId = 'other-evidence';
  const store = new MemoryHarnessHistoryPublicationStore();
  const source = {
    baseline: async () => a,
    read: async (revision: string) => (revision === b ? after : before),
    acquire: async () => after,
  };
  const owner = new HarnessHistoryPublicationOwner({ store, source });
  const initial = await owner.read(input);
  assert.equal(initial.status, 'resolved');
  if (initial.status !== 'resolved') return;
  const selectedNode = initial.nodes.find((node) => node.nodeRef.ownerStateRef.endsWith(child.stepId));
  assert.ok(selectedNode);

  assert.equal((await owner.publish(input, publish(0), actor)).outcome, 'appended');
  const pinned = await owner.read({
    ...input,
    selectedSourceRef: initial.sourceRef,
    selectedNodeRef: selectedNode.nodeRef,
  });
  assert.equal(pinned.status, 'resolved');
  if (pinned.status !== 'resolved') return;
  assert.equal(pinned.publication?.selectionUpdate?.kind, 'modified');
});

test('changing a case source visible from a selected node requires explicit adoption', async () => {
  const before = f314HistoryV3Fixture(archive);
  before.story.sources.push({
    ...before.story.sources[0],
    id: 'other-case-evidence',
    label: '另一份案例原件',
  });
  const after = structuredClone(before);
  after.story.cases[0].sourceIds = ['other-case-evidence'];
  const store = new MemoryHarnessHistoryPublicationStore();
  const source = {
    baseline: async () => a,
    read: async (revision: string) => (revision === b ? after : before),
    acquire: async () => after,
  };
  const owner = new HarnessHistoryPublicationOwner({ store, source });
  const initial = await owner.read(input);
  assert.equal(initial.status, 'resolved');
  if (initial.status !== 'resolved') return;
  const selectedCase = before.story.cases[0];
  const selectedNode = initial.nodes.find((node) => node.nodeRef.ownerStateRef.endsWith(selectedCase.stepId));
  assert.ok(selectedNode);

  assert.equal((await owner.publish(input, publish(0), actor)).outcome, 'appended');
  const pinned = await owner.read({
    ...input,
    selectedSourceRef: initial.sourceRef,
    selectedNodeRef: selectedNode.nodeRef,
  });
  assert.equal(pinned.status, 'resolved');
  if (pinned.status !== 'resolved') return;
  assert.equal(pinned.publication?.selectionUpdate?.kind, 'modified');
});

test('content-identical publication re-signing remains unchanged for an exact node and case selection', async () => {
  const current = f314HistoryV3Fixture(archive);
  const store = new MemoryHarnessHistoryPublicationStore();
  const source = {
    baseline: async () => a,
    read: async () => current,
    acquire: async () => current,
  };
  const owner = new HarnessHistoryPublicationOwner({ store, source });
  const initial = await owner.read(input);
  assert.equal(initial.status, 'resolved');
  if (initial.status !== 'resolved') return;
  const selectedExperiment = initial.experiments[0];
  assert.ok(selectedExperiment);

  assert.equal((await owner.publish(input, publish(0), actor)).outcome, 'appended');
  const pinned = await owner.read({
    ...input,
    selectedSourceRef: initial.sourceRef,
    selectedNodeRef: selectedExperiment.nodeRef,
    selectedExperimentRef: selectedExperiment.experimentRef,
  });
  assert.equal(pinned.status, 'resolved');
  if (pinned.status !== 'resolved') return;
  assert.equal(pinned.publication?.selectionUpdate?.kind, 'unchanged');
});

test('overlong ignored-field diagnostics stay bounded before the publication journal append', async () => {
  const current = f314HistoryV3Fixture(archive);
  const ignoredFieldPath = `/story/steps/0/${'x'.repeat(1_001)}`;
  const store = new MemoryHarnessHistoryPublicationStore();
  const source = {
    baseline: async () => a,
    read: async () => current,
    acquire: async () => current,
    ignoredFieldPaths: async () => [ignoredFieldPath],
  };
  const owner = new HarnessHistoryPublicationOwner({ store, source });

  const result = await owner.publish(input, publish(0), actor);
  assert.equal(result.outcome, 'appended');
  assert.equal('attempt' in result && result.attempt.status, 'published');
  const diagnostic = 'attempt' in result ? result.attempt.ignoredFieldPaths?.[0] : undefined;
  assert.ok(diagnostic);
  assert.ok(diagnostic.length <= 1_000);
  assert.match(diagnostic, /\[sha256:[a-f0-9]{64}\]$/);
});

test('v3 publication reports stripped extensions, refreshes in-process, and preserves current on unsafe Markdown', async () => {
  const safe = f314HistoryV3Fixture(archive);
  Object.assign(safe.story.sources[0], { futureSourceField: true });
  Object.assign(safe.story.steps[0], { futureStepField: { layout: 'future' } });
  Object.assign(safe.story.cases[0], { futureCaseField: 1 });
  const unsafe = structuredClone(safe);
  unsafe.story.cases[0].bodyMarkdown = '[unsafe](javascript:alert(1))';
  const store = new MemoryHarnessHistoryPublicationStore();
  const source = {
    baseline: async () => a,
    read: async (revision: string) => (revision === b ? safe : revision === d ? unsafe : archive),
    acquire: async (revision: string) => (revision === b ? safe : revision === d ? unsafe : archive),
    ignoredFieldPaths: async (revision: string) =>
      revision === b
        ? ['/story/sources/0/futureSourceField', '/story/steps/0/futureStepField', '/story/cases/0/futureCaseField']
        : [],
  };
  const owner = new HarnessHistoryPublicationOwner({ store, source });

  const published = await owner.publish(input, publish(0, b, 'publish-v3'), actor);
  assert.equal(published.outcome, 'appended');
  assert.equal('attempt' in published && published.attempt.status, 'published');
  assert.deepEqual(
    'attempt' in published
      ? (published.attempt as typeof published.attempt & { ignoredFieldPaths?: string[] }).ignoredFieldPaths
      : undefined,
    ['/story/cases/0/futureCaseField', '/story/sources/0/futureSourceField', '/story/steps/0/futureStepField'],
  );
  const current = await owner.read(input);
  assert.equal(current.status, 'resolved');
  if (current.status !== 'resolved') return;
  assert.equal(current.overviewMarkdown, safe.story.overviewMarkdown);
  assert.equal(current.nodes[0]?.bodyMarkdown, safe.story.steps[0]?.bodyMarkdown);

  const rejected = await owner.publish(input, publish(1, d, 'publish-unsafe-v3'), actor);
  assert.equal('attempt' in rejected && rejected.attempt.status, 'failed');
  assert.equal('attempt' in rejected && rejected.attempt.failureCode, 'invalid_history');
  const after = await owner.read(input);
  assert.equal(after.status, 'resolved');
  if (after.status !== 'resolved') return;
  assert.equal(after.sourceRef.version, current.sourceRef.version);
  assert.equal(after.nodes[0]?.bodyMarkdown, safe.story.steps[0]?.bodyMarkdown);
});
