import type { EvolutionExplorationExperimentV1, EvolutionExplorationRecordV1 } from '@cat-cafe/shared';
import { archiveDigest, archiveRef } from './archive-reader.js';
import { type CortexRun, cortexHref, cortexSourceRef } from './cortex-reader.js';

export const cortexNodeRef = archiveRef('cortex-archive-container', cortexSourceRef.version ?? '');
const runRef = (run: CortexRun) => archiveRef('cortex-run', run.manifestFile.sha256);
const evidenceRef = runRef;
const measurementRef = (run: CortexRun) => archiveRef('cortex-summary', run.summaryFile.sha256);
const windowRef = (run: CortexRun) => archiveRef('cortex-window', archiveDigest({ seconds: run.manifest.seconds }));
export const cortexMedia = (run: CortexRun) => [
  {
    mediaRef: archiveRef('cortex-media', run.videoFile.sha256),
    kind: 'video' as const,
    contentType: 'video/mp4' as const,
    label: '完整比赛原件',
    provenance: 'original' as const,
    sourceRecordRef: evidenceRef(run),
    durationSeconds: run.manifest.seconds,
  },
  {
    mediaRef: archiveRef('cortex-media', run.posterFile.sha256),
    kind: 'image' as const,
    contentType: 'image/png' as const,
    label: '原归档联系表（整场原片派生帧）',
    provenance: 'original' as const,
    sourceRecordRef: evidenceRef(run),
  },
];
const metricLabels = {
  gold_goals: '金队进球',
  blue_goals: '蓝队进球',
  connected_kicks: '指定脚命中',
  falls: '摔倒',
  accepted_commands: '接受指令',
  rejected_commands: '拒绝指令',
  max_lag_s: '最大延迟',
  p95_lag_s: 'P95延迟',
};

export function projectCortexExperiment(run: CortexRun): EvolutionExplorationExperimentV1 {
  const sourceRef = runRef(run);
  return {
    experimentRef: runRef(run),
    nodeRef: cortexNodeRef,
    sourceRef,
    title: `${run.id} · ${run.manifest.seconds}秒`,
    status: 'recorded',
    recordCount: 1,
    conditions: {
      environment: {
        label: `MuJoCo ${run.manifest.source.mujoco} · ${run.manifest.scenario.name}`,
        detail: `${run.manifest.actuator}；控制${run.manifest.control_hz}Hz，接触${run.manifest.contact_hz}Hz；局部反馈：${run.annotation.observation_domain}。`,
        sourceRef,
      },
      sampleSet: {
        label: `1场比赛 · seed ${run.manifest.seed}`,
        detail: '保留整场记录；两场时长与源码不同，不能当作单变量独立配对。',
        sourceRef,
      },
      measurement: {
        label: '原归档比赛汇总',
        detail: '原 summary 的进球、指定脚命中、摔倒与指令延迟；不改写为能力效用 verdict。',
        sourceRef: measurementRef(run),
      },
      groundTruth: {
        label: '仿真世界态与接触记录',
        detail: '只适用于原仿真；没有独立现实或专家效用GT。',
        status: 'bounded',
        sourceRef,
      },
      window: {
        label: `0–${run.manifest.seconds}秒`,
        detail: '完整原始观察窗。前10秒联看是阅读窗口，不替代整场测量。',
        sourceRef: windowRef(run),
      },
      exposure: 'public_development',
      limitation:
        '公开开发原件；没有独立验证、正式资产版本、采用或版本父边。局部观察与控制组合、源码及120/240秒观察窗都不同。',
      threshold: { status: 'unknown', detail: '没有已冻结的足球能力效用门槛；比分不是改善证明。' },
      comparison: { design: 'undeclared', method: '两场描述性并看；未声明同窗单变量配对，不计算因果改善。' },
      preparationRefs: [
        { label: '完整环境与源码hash', ref: sourceRef, href: cortexHref(run.manifestFile.path) },
        {
          label: '观察域与字幕来源',
          ref: archiveRef('cortex-annotation', run.annotationFile.sha256),
          href: cortexHref(run.annotationFile.path),
        },
      ],
    },
    metrics: Object.entries(metricLabels).map(([key, label]) => ({
      key,
      label,
      unit: key.endsWith('_s') ? 's' : '次',
      definition: `原 summary 中的${label}；不代表独立样本或效用门槛。`,
      sourceRef: measurementRef(run),
    })),
  };
}

export function projectCortexRecord(run: CortexRun): EvolutionExplorationRecordV1 {
  const values = {
    gold_goals: run.summary.team_scores.gold,
    blue_goals: run.summary.team_scores.blue,
    connected_kicks: run.summary.connected_kick_ids.length,
    falls: Object.values(run.summary.falls).reduce((a, b) => a + b, 0),
    accepted_commands: run.summary.accepted_commands,
    rejected_commands: run.summary.rejected_commands,
    max_lag_s: run.summary.max_lag_s,
    p95_lag_s: run.summary.p95_lag_s,
  };
  return {
    recordRef: archiveRef('cortex-record', archiveDigest({ run: runRef(run), summary: measurementRef(run) })),
    experimentRef: runRef(run),
    nodeRef: cortexNodeRef,
    caseId: run.manifest.run_id,
    label: run.id,
    inputRef: archiveRef(
      'cortex-input',
      archiveDigest({ seed: run.manifest.seed, rules: run.manifest.rules, scenario: run.manifest.scenario }),
    ),
    evidenceRef: evidenceRef(run),
    windowRef: windowRef(run),
    measurementRef: measurementRef(run),
    input: [
      { label: '局部反馈', value: run.annotation.label },
      { label: '观察窗', value: `${run.manifest.seconds}秒；seed ${run.manifest.seed}` },
      { label: '源码', value: `${run.manifest.source.lab_sha}\n${JSON.stringify(run.manifest.source.source_hashes)}` },
    ],
    output: Object.entries(values).map(([key, value]) => ({
      label: metricLabels[key as keyof typeof metricLabels],
      value: String(value),
    })),
    result: { status: 'observed', label: `归档比分 ${values.gold_goals}:${values.blue_goals} · 效用门槛未知` },
    values,
    media: cortexMedia(run),
    sources: [
      { label: '环境、源码与运行原件', ref: runRef(run), href: cortexHref(run.manifestFile.path) },
      { label: '原始比赛汇总', ref: measurementRef(run), href: cortexHref(run.summaryFile.path) },
      {
        label: '局部反馈来源',
        ref: archiveRef('cortex-annotation', run.annotationFile.sha256),
        href: cortexHref(run.annotationFile.path),
      },
      {
        label: '完整原始轨迹（归档，不解压为新指标）',
        ref: cortexSourceRef,
        href: cortexHref(`${run.id}/trajectory.jsonl.gz`),
      },
    ],
  };
}
