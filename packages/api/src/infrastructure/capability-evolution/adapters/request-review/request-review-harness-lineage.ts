import { posix } from 'node:path';
import {
  type EvolutionExplorationDetailV1,
  type EvolutionExplorationExperimentV1,
  type EvolutionExplorationRequestV1,
  type EvolutionResolvedExplorationReviewV1,
  type OwnerTruthRefV1,
  refIdentity,
} from '@cat-cafe/shared';
import {
  type RequestReviewHarnessLineageIndex,
  requestReviewHarnessLineageIndexSchema,
} from './request-review-harness-lineage-schema.js';
import { projectHarnessStoryV3Nodes, v3CaseNarrative, v3CaseSources } from './request-review-harness-lineage-v3.js';
import {
  harnessStoryNodeRef,
  projectHarnessStoryNodes,
  storyCaseNarrative,
  storyCaseSources,
} from './request-review-harness-story.js';

export { requestReviewHarnessLineageIndexSchema } from './request-review-harness-lineage-schema.js';

type ResolvedDetail = Extract<EvolutionExplorationDetailV1, { status: 'resolved' }>;
type ExplorationRecord = ResolvedDetail['records'][number];

const ref = (kind: string, id: string, version: string): OwnerTruthRefV1 => ({
  ownerFeatureId: 'F314',
  ownerStateRef: `harness-history:${kind}:${id}`,
  version,
});

const indexRef = (index: RequestReviewHarnessLineageIndex) => ref('index', 'development-process', index.snapshotCommit);

const releaseRef = (release: RequestReviewHarnessLineageIndex['releases'][number], version?: string) =>
  ref('release', release.id, version ?? release.version);

const commitRef = (commit: { fullSha?: string; sha: string }) => {
  const fullSha = commit.fullSha ?? commit.sha;
  return ref('commit', fullSha, fullSha);
};

function caseRef(entry: RequestReviewHarnessLineageIndex['cases'][number], version?: string) {
  return ref('case', entry.caseId ?? entry.sourceTextSha256.slice(0, 16), version ?? entry.sourceTextSha256);
}

function sourceHref(index: RequestReviewHarnessLineageIndex, link?: string | null): string {
  const raw = link || 'README.md';
  const [file, anchor] = raw.split('#', 2);
  const path = posix.normalize(posix.join('docs/discussions/f314-incident-archive', file || 'README.md'));
  return `https://github.com/zts212653/clowder-ai/blob/${index.snapshotCommit}/${path}${anchor ? `#${anchor}` : ''}`;
}

function commitHref(commit: { fullSha?: string; sha: string }): string {
  return `https://github.com/zts212653/clowder-ai/commit/${commit.fullSha ?? commit.sha}`;
}

function ownerReviewHref(index: RequestReviewHarnessLineageIndex): string {
  return `https://github.com/zts212653/clowder-ai/blob/${index.ownerReviewCommit}/${posix.normalize(index.ownerReviewRef)}`;
}

function conditions(
  index: RequestReviewHarnessLineageIndex,
  entry: RequestReviewHarnessLineageIndex['cases'][number],
  publicationRef?: OwnerTruthRefV1,
) {
  const source = caseRef(entry);
  const windowLabel = entry.occurredWindow
    ? `${entry.occurredWindow.start} → ${entry.occurredWindow.end}`
    : entry.occurredOn;
  return {
    environment: {
      label: 'F314 开发事故档案',
      detail: index.story
        ? '原始托付、当时处置与后续实物的历史记录。'
        : '固定 Git cut 上的历史原文索引；不是生产运行回放。',
      sourceRef: publicationRef ?? indexRef(index),
    },
    sampleSet: {
      label: '1 条历史案例原文',
      detail: '案例是具名原件，不是概率样本，也不代表同类事故总数。',
      sourceRef: source,
    },
    measurement: {
      label: '描述性来源核对',
      detail: '只核发生时间、原文引用和成员提交；不测版本效果。',
      sourceRef: publicationRef ?? indexRef(index),
    },
    groundTruth: {
      label: '案例原文与可核 Git/PR 引用',
      detail: '引用证明原文谈到该对象；不自动证明采用、因果或效用。',
      sourceRef: source,
      status: 'bounded' as const,
    },
    window: {
      label: windowLabel,
      detail: '发生时间或原文明确的有界观察窗；与文档整理日期分开。',
      sourceRef: ref('window', entry.sourceTextSha256, entry.sourceTextSha256),
    },
    exposure: 'public_development' as const,
    limitation: index.story
      ? '连线表示原件支持的应对与后续修订。实际结果逐案写明，不据这些案例计算整体改善率。'
      : '日期组只用于浏览；本案例实际沿用版本未确认，不能用它判断哪一版有效。',
    threshold: {
      status: 'unknown' as const,
      detail: '没有冻结的版本效用门槛；这是历史来源阅读，不是比较实验。',
    },
    comparison: {
      design: 'undeclared' as const,
      method: '未建立版本效果比较；不把日期前后或引用提交拼成配对。',
    },
    preparationRefs: [
      { label: '打开案例原文', ref: source, href: sourceHref(index, entry.link) },
      ...(index.schemaVersion === 3 ? v3CaseSources(index, entry) : storyCaseSources(index, entry)),
      {
        label: 'F314 owner 核对',
        ref: ref('owner-review', 'development-process', index.ownerReviewCommit),
        href: ownerReviewHref(index),
      },
    ],
  };
}

function projectExperiment(
  index: RequestReviewHarnessLineageIndex,
  entry: RequestReviewHarnessLineageIndex['cases'][number],
  release: RequestReviewHarnessLineageIndex['releases'][number],
  publicationRef?: OwnerTruthRefV1,
): EvolutionExplorationExperimentV1 {
  const v3Narrative = index.schemaVersion === 3 ? v3CaseNarrative(index, entry) : undefined;
  const legacyNarrative = index.schemaVersion === 3 ? undefined : storyCaseNarrative(index, entry);
  return {
    experimentRef: caseRef(entry, publicationRef?.version),
    nodeRef: v3Narrative
      ? harnessStoryNodeRef(index, v3Narrative.stepId, publicationRef?.version)
      : legacyNarrative
        ? harnessStoryNodeRef(index, legacyNarrative.nodeId, publicationRef?.version)
        : releaseRef(release, publicationRef?.version),
    sourceRef: caseRef(entry),
    title: (v3Narrative?.title ?? legacyNarrative?.title ?? legacyNarrative?.problem ?? entry.summary).slice(0, 240),
    status: 'recorded',
    recordCount: 1,
    conditions: conditions(index, entry, publicationRef),
    metrics: [],
  };
}

function projectDetail(
  index: RequestReviewHarnessLineageIndex,
  entry: RequestReviewHarnessLineageIndex['cases'][number],
  experiment: EvolutionExplorationExperimentV1,
  publicationRef?: OwnerTruthRefV1,
): EvolutionExplorationDetailV1 {
  const evidence = caseRef(entry);
  const citations = entry.citedMemberCommits;
  const v3Narrative = index.schemaVersion === 3 ? v3CaseNarrative(index, entry) : undefined;
  const legacyNarrative = index.schemaVersion === 3 ? undefined : storyCaseNarrative(index, entry);
  const input: ExplorationRecord['input'] = [
    { label: '发生时间', value: experiment.conditions.window.label },
    { label: '文档整理日期', value: entry.documentedOn },
  ];
  if (!v3Narrative && !legacyNarrative)
    input.push({ label: '日期浏览组', value: `${entry.browsingBucket}（不代表实际沿用）` });
  let output: ExplorationRecord['output'];
  let result: ExplorationRecord['result'];
  if (v3Narrative) {
    output = [];
    result = { status: 'observed', label: v3Narrative.title };
  } else if (legacyNarrative) {
    output = [
      { label: '踩了什么坑', value: legacyNarrative.problem },
      { label: '当时怎么应对', value: legacyNarrative.response },
    ];
    result = { status: 'observed', label: legacyNarrative.outcome };
  } else {
    output = [
      { label: '实际沿用版本', value: '未确认' },
      {
        label: '成员提交引用',
        value: citations.length ? citations.map((item) => item.sha).join('、') : '未找到可核成员提交引用',
      },
    ];
    result = { status: 'unknown', label: '历史案例来源已归档；不是版本效用判定。' };
  }
  return {
    status: 'resolved',
    experimentRef: experiment.experimentRef,
    nodeRef: experiment.nodeRef,
    records: [
      {
        recordRef: ref('record', entry.sourceTextSha256, publicationRef?.version ?? entry.sourceTextSha256),
        experimentRef: experiment.experimentRef,
        nodeRef: experiment.nodeRef,
        caseId: entry.caseId ?? entry.sourceTextSha256.slice(0, 16),
        label: (v3Narrative?.title ?? entry.summary).slice(0, 240),
        ...(v3Narrative ? { bodyMarkdown: v3Narrative.bodyMarkdown } : {}),
        inputRef: evidence,
        evidenceRef: evidence,
        windowRef: experiment.conditions.window.sourceRef,
        measurementRef: experiment.conditions.measurement.sourceRef,
        input,
        output,
        result,
        values: {},
        media: [],
        sources: [
          { label: '案例原文', ref: evidence, href: sourceHref(index, entry.link) },
          ...(index.schemaVersion === 3 ? v3CaseSources(index, entry) : storyCaseSources(index, entry)),
          ...citations.slice(0, 15).map((citation) => ({
            label: `原文引用 · ${citation.relation}`,
            ref: commitRef(citation),
            href: commitHref(citation),
          })),
        ],
      },
    ],
  };
}

export function projectRequestReviewHarnessExploration(
  input: EvolutionExplorationRequestV1,
  rawIndex: unknown,
  readAt: string,
  publicationRef?: OwnerTruthRefV1,
): EvolutionResolvedExplorationReviewV1 | null {
  const parsed = requestReviewHarnessLineageIndexSchema.safeParse(rawIndex);
  if (!parsed.success) return null;
  const index = parsed.data;
  const byId = new Map(index.releases.map((release) => [release.id, release]));
  const nodes: EvolutionResolvedExplorationReviewV1['nodes'] =
    index.schemaVersion === 3
      ? projectHarnessStoryV3Nodes(index, publicationRef)
      : index.story
        ? projectHarnessStoryNodes(index, index.story, publicationRef)
        : index.releases.map((release) => ({
            kind: 'public_archive',
            nodeRef: releaseRef(release, publicationRef?.version),
            title: `${release.id} · ${release.date}`,
            summary: `作者日期 ${release.date} 的 ${release.commits.length} 个提交浏览组；不代表发布、加载或采用。`,
            sourceRef: publicationRef ?? indexRef(index),
            changes: release.commits.slice(0, 32).map((commit) => ({
              label: commit.members.join('、'),
              detail: commit.subject,
              sourceRef: commitRef(commit),
              ownerHref: commitHref(commit),
            })),
            parentEdges: [],
          }));
  const pairs = index.cases.map((entry) => {
    const browsingBucket = entry.browsingBucket;
    if (!browsingBucket) throw new Error('validated F314 case bucket disappeared');
    const release = byId.get(browsingBucket);
    if (!release) throw new Error('validated F314 browsing bucket disappeared');
    const experiment = projectExperiment(index, entry, release, publicationRef);
    return { entry, experiment };
  });
  const requested = new Set(
    [input.selectedExperimentRef, input.comparisonExperimentRef]
      .filter((value): value is NonNullable<typeof value> => value !== undefined)
      .map(refIdentity),
  );
  return {
    schemaVersion: 1,
    status: 'resolved',
    programRef: input.programRef,
    objectRef: input.objectRef,
    sourceRef: publicationRef ?? indexRef(index),
    readAt,
    ...(index.schemaVersion === 3
      ? { overviewMarkdown: index.story.overviewMarkdown }
      : index.story?.overview
        ? { overview: index.story.overview }
        : {}),
    nodes,
    experiments: pairs.map(({ experiment }) => experiment),
    details: pairs
      .filter(({ experiment }) => requested.has(refIdentity(experiment.experimentRef)))
      .map(({ entry, experiment }) => projectDetail(index, entry, experiment, publicationRef)),
    blockers: [
      {
        code: index.story ? 'public_archive_not_program_adoption' : 'historical_index_not_adoption',
        ownerRef: input.objectRef,
      },
    ],
  };
}
