import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { evolutionExplorationReviewV1Schema } from '@cat-cafe/shared';
import { projectRequestReviewHarnessExploration } from '../src/infrastructure/capability-evolution/adapters/request-review/request-review-harness-lineage.js';
import { f314HistoryV3Fixture } from './helpers/f314-history-v3-fixture.js';

const archive = JSON.parse(
  readFileSync(
    new URL('../../shared/src/__tests__/fixtures/f314-history-publication-contract.json', import.meta.url),
    'utf8',
  ),
);
const input = {
  programRef: { ownerFeatureId: 'F311', ownerStateRef: 'program:history', version: '1' },
  objectRef: {
    ownerFeatureId: 'F100',
    ownerStateRef: 'capability:development-process-harness-effectiveness',
    version: '1',
  },
};
const readAt = '2026-10-16T10:30:00.000Z';
test('the exported F314 contract fixture opens a selected case with its bounded later outcome', () => {
  const catalog = projectRequestReviewHarnessExploration(input, archive, readAt);
  assert(catalog);
  assert.equal(evolutionExplorationReviewV1Schema.safeParse(catalog).success, true);
  assert.deepEqual(
    catalog.blockers.map((blocker) => blocker.code),
    ['public_archive_not_program_adoption'],
  );
  assert.deepEqual(
    catalog.nodes.map((node) => node.title),
    archive.story.nodes.map((node: { title: string }) => node.title),
  );
  const saved = catalog.experiments.find((entry) =>
    entry.experimentRef.ownerStateRef.includes('contract-save-readback'),
  );
  assert(saved, 'the synthetic save/readback counterexample must be reachable from exploration');
  const detail = projectRequestReviewHarnessExploration(
    { ...input, selectedExperimentRef: saved.experimentRef },
    archive,
    readAt,
  );
  assert(detail);
  assert.equal(evolutionExplorationReviewV1Schema.safeParse(detail).success, true);
  const record = detail.details[0]?.status === 'resolved' ? detail.details[0].records[0] : undefined;
  assert(record);
  const savedEvidence = record.output[0];
  const readbackEvidence = record.output[1];
  assert(savedEvidence);
  assert(readbackEvidence);
  assert.match(savedEvidence.value, /保存/);
  assert.match(savedEvidence.value, /深滚|向下滚很远/);
  assert.match(readbackEvidence.value, /真实回读|真实读取/);
  assert.match(record.result.label, /正式/);
  assert.match(record.result.label, /自然/);
  assert.doesNotMatch(record.result.label, /服务器没存|正式写入/);
});

const fixture = () => ({
  ...archive,
  schemaVersion: 2,
  status: 'source-backed-evolution-story',
  cases: archive.cases.slice(0, 2).map((entry: object, index: number) => ({ ...entry, caseId: `case-${index}` })),
  story: {
    updated: '2026-10-16',
    overview: '一开始只看检查是否通过。后来把原始托付、真实操作和失败一起带进交付。',
    sources: [
      {
        id: 'journey',
        label: '真实输入验收修订',
        path: 'docs/discussions/f314-incident-archive/cases/2026-10-07-f232-plan-only-shadow-replay.md',
      },
    ],
    nodes: [
      {
        id: 'complete-result',
        when: '9月19日',
        title: '先看整件事是否完成',
        summary: '局部通过后仍要对照原托付。',
        parents: [],
        changes: [{ label: '应对', detail: '把原始结果带进交付判断。', sourceId: 'journey' }],
      },
      {
        id: 'real-input',
        when: '10月7日',
        title: '用需求方的真实例子验收',
        summary: '能列出产物还不够，原话里的文件必须点得开。',
        parents: [
          { nodeId: 'complete-result', sourceId: 'journey', reason: '沿完整旅程要求，进一步固定真实输入与核心动作。' },
        ],
        changes: [{ label: '应对', detail: '打开需求方点名的 backlog。', sourceId: 'journey' }],
      },
    ],
    cases: [
      {
        caseId: 'case-0',
        nodeId: 'complete-result',
        title: '局部通过不是完成',
        problem: '局部批准被当成整项完成。',
        response: '恢复原始需求并区分批准范围。',
        outcome: '局部证据保留，完整交付继续。',
        sourceIds: ['journey'],
      },
      {
        caseId: 'case-1',
        nodeId: 'real-input',
        title: '真实文件必须点得开',
        problem: '清单能列出 backlog，却打不开内容。',
        response: '改用需求方的真实文件，从打开走到读到正文。',
        outcome: '真实输入要求已落地；后续案例仍暴露执行遗漏。',
        sourceIds: ['journey'],
      },
    ],
  },
});

test('publishes declared problem-to-response lineage instead of unrelated calendar buckets', () => {
  const result = projectRequestReviewHarnessExploration(input, fixture(), readAt);
  assert(result, 'source-backed history must be available in the existing exploration surface');
  assert.equal(evolutionExplorationReviewV1Schema.safeParse(result).success, true);
  assert.equal(
    (result as typeof result & { overview?: string }).overview,
    '一开始只看检查是否通过。后来把原始托付、真实操作和失败一起带进交付。',
  );
  assert.deepEqual(
    result.experiments.map((experiment) => experiment.title),
    ['局部通过不是完成', '真实文件必须点得开'],
  );
  assert.deepEqual(
    result.nodes.map((node) => node.title),
    ['先看整件事是否完成', '用需求方的真实例子验收'],
  );
  assert.deepEqual(result.nodes[1]?.parentEdges[0]?.parentNodeRef, result.nodes[0]?.nodeRef);
  assert.equal(result.nodes[1]?.parentEdges[0]?.description, '沿完整旅程要求，进一步固定真实输入与核心动作。');
  assert.deepEqual(result.nodes[0]?.kind === 'public_archive' && result.nodes[0].history, {
    period: '9月19日',
    updatedThrough: '2026-10-16',
  });
  assert(result.nodes.every((node) => node.kind === 'public_archive'));
  assert.equal(result.details.length, 0);
});

test('selected case shows the problem, concrete response and later outcome with pinned sources', () => {
  const index = fixture();
  const catalog = projectRequestReviewHarnessExploration(input, index, readAt);
  assert(catalog);
  const selected = catalog.experiments[1];
  assert(selected);
  const result = projectRequestReviewHarnessExploration(
    { ...input, selectedExperimentRef: selected.experimentRef },
    index,
    readAt,
  );
  const record = result?.details[0]?.status === 'resolved' ? result.details[0].records[0] : undefined;
  assert(record);
  assert.deepEqual(
    record.output.map((entry) => entry.label),
    ['踩了什么坑', '当时怎么应对'],
  );
  assert.match(record.result.label, /后续案例仍暴露执行遗漏/);
  assert.equal(record.result.status, 'observed');
  assert(record.sources.some((source) => source.href?.includes(`/blob/${index.snapshotCommit}/docs/`)));
  assert.equal(result?.experiments[1]?.metrics.length, 0, 'historical outcomes must not invent efficacy scores');
});

test('rejects unsupported relationships and missing case narratives rather than filling chronology', () => {
  const missing = fixture();
  const missingParent = missing.story.nodes[1]?.parents[0];
  assert(missingParent);
  missingParent.sourceId = 'not-a-source';
  assert.equal(projectRequestReviewHarnessExploration(input, missing, readAt), null);
  const cyclic = fixture();
  const root = cyclic.story.nodes[0];
  assert(root);
  root.parents.push({ nodeId: 'real-input', sourceId: 'journey', reason: 'invalid cycle' });
  assert.equal(projectRequestReviewHarnessExploration(input, cyclic, readAt), null);
  const incomplete = fixture();
  incomplete.story.cases.pop();
  assert.equal(projectRequestReviewHarnessExploration(input, incomplete, readAt), null);
});

test('v3 projects author Markdown without rebuilding it from semantic JSON fields', () => {
  const index = f314HistoryV3Fixture(archive);
  const catalog = projectRequestReviewHarnessExploration(input, index, readAt);
  assert(catalog, 'the v3 author contract must project through the existing exploration owner');
  assert.equal(evolutionExplorationReviewV1Schema.safeParse(catalog).success, true);
  assert.equal(catalog.overviewMarkdown, index.story.overviewMarkdown);
  assert.equal(catalog.overview, undefined);
  assert.deepEqual(
    catalog.nodes.map((node) => [node.title, node.bodyMarkdown, node.changes]),
    index.story.steps.map((step) => [step.title, step.bodyMarkdown, []]),
  );
  assert.deepEqual(
    catalog.nodes.map((node) => node.kind === 'public_archive' && node.history.period),
    index.story.steps.map((step) => step.date),
  );
  assert.deepEqual(
    catalog.experiments.map((experiment) => experiment.title),
    index.story.cases.map((entry) => entry.title),
  );

  const selected = catalog.experiments[1];
  assert(selected);
  const detail = projectRequestReviewHarnessExploration(
    { ...input, selectedExperimentRef: selected.experimentRef },
    index,
    readAt,
  );
  const record = detail?.details[0]?.status === 'resolved' ? detail.details[0].records[0] : undefined;
  assert(record);
  assert.equal(record.bodyMarkdown, index.story.cases[1]?.bodyMarkdown);
  assert.deepEqual(record.output, []);
  assert(record.sources.some((source) => source.href?.includes('/blob/')));
});

test('v3 strips unknown author extensions while preserving known content and rejects broken skeletons', () => {
  const extended = f314HistoryV3Fixture(archive);
  Object.assign(extended.story, { futureStoryField: { presentation: 'future' } });
  Object.assign(extended.story.sources[0], { futureSourceField: true });
  Object.assign(extended.story.steps[0], { futureStepField: ['ignored'] });
  Object.assign(extended.story.cases[0], { futureCaseField: 1 });
  const projected = projectRequestReviewHarnessExploration(input, extended, readAt);
  assert(projected);
  assert.equal(projected.nodes[0]?.bodyMarkdown, extended.story.steps[0]?.bodyMarkdown);

  const missingParent = f314HistoryV3Fixture(archive);
  missingParent.story.steps[1].parentEdges[0].parentStepId = 'missing-step';
  assert.equal(projectRequestReviewHarnessExploration(input, missingParent, readAt), null);

  const missingSource = f314HistoryV3Fixture(archive);
  missingSource.story.cases[0].sourceIds = ['missing-source'];
  assert.equal(projectRequestReviewHarnessExploration(input, missingSource, readAt), null);

  const dangerous = f314HistoryV3Fixture(archive);
  dangerous.story.steps[0].bodyMarkdown = '[unsafe](javascript:alert(1))';
  assert.equal(projectRequestReviewHarnessExploration(input, dangerous, readAt), null);
});
