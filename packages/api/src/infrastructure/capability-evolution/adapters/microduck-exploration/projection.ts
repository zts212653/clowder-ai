import type {
  EvolutionExplorationExperimentV1,
  EvolutionExplorationMetricV1,
  EvolutionExplorationNodeV1,
} from '@cat-cafe/shared';
import {
  ArchiveIntegrityError,
  archiveDigest,
  archiveRef,
  type FootballArchiveCatalog,
  type FootballArchiveRun,
} from './archive-reader.js';
import {
  comparisonPlanRef,
  inputIdentity,
  MEASUREMENT_DEFINITION,
  measurementRef,
  windowIdentity,
} from './observation.js';

export const FOOTBALL_METRICS: EvolutionExplorationMetricV1[] = [
  {
    key: 'trunk_travel',
    label: '踢前躯干 XY 累计位移',
    unit: 'm',
    definition: '从 t=1s 到 kick 或原窗口终点，相邻 50Hz 躯干 XY 位移之和；含步态摆动，非几何路径或脚里程。',
    sourceRef: measurementRef,
  },
  {
    key: 'yaw_span',
    label: '踢前躯干 yaw 跨度',
    unit: '°',
    definition: '从 t=1s 到 kick 或原窗口终点，连续展开 yaw 的最大值减最小值。',
    sourceRef: measurementRef,
  },
  {
    key: 'foot_contact',
    label: '无提前触球且踢后指定脚触球',
    unit: '条',
    definition: '每条记录为 1/0；不独立、不等同足球成功。',
    sourceRef: measurementRef,
  },
  {
    key: 'kick_time',
    label: '踢球触发时间',
    unit: 's',
    definition: '原始时间轴的第一个 kick_trigger；未触发为空。',
    sourceRef: measurementRef,
  },
  {
    key: 'first_foot_contact',
    label: '踢后首次指定脚接触',
    unit: 's',
    definition: 'kick_trigger 之后指定 ankle 的首次接触；未触发或未接触为空。',
    sourceRef: measurementRef,
  },
  {
    key: 'before_contact_count',
    label: '踢前或未踢球接触',
    unit: '次',
    definition: '窗口内 kick 前，或无 kick 时的机器人/球接触条数。',
    sourceRef: measurementRef,
  },
];

export function projectFootballNodes(catalog: FootballArchiveCatalog): EvolutionExplorationNodeV1[] {
  return catalog.versions.map((version) => {
    const first = catalog.runs.find((run) => run.version === version.id);
    if (!first) throw new ArchiveIntegrityError('public archive group has no actual run receipt');
    const parent = catalog.versions.find((entry) => entry.id === version.parent);
    return {
      kind: 'public_archive',
      nodeRef: first.nodeRef,
      title: version.id,
      summary: version.summary,
      sourceRef: version.sourceRef,
      changes: [{ label: '这一组改动', detail: version.summary, sourceRef: version.sourceRef }],
      parentEdges: parent
        ? [{ parentNodeRef: archiveRef('public-controller', parent.fingerprint), sourceRef: version.sourceRef }]
        : [],
    };
  });
}

export function projectFootballExperiment(run: FootballArchiveRun): EvolutionExplorationExperimentV1 {
  const { index } = run;
  const { episode, metrics: _walkingMetrics, ...rest } = index.environment;
  const environmentRef = archiveRef(
    'environment',
    archiveDigest({
      ...rest,
      runtimeDependencies: index.runtimeDependencies,
      physics: {
        controlHz: episode.controlHz,
        substeps: episode.physicsSubstepsPerControl,
        timestep: episode.physicsTimestepSeconds,
      },
    }),
  );
  const sourceRef = archiveRef('run-index', run.indexRef.sha256);
  return {
    experimentRef: run.experimentRef,
    nodeRef: run.nodeRef,
    sourceRef,
    title: `${run.version} · ${run.id}`,
    status: 'recorded',
    recordCount: index.episodes.length,
    conditions: {
      environment: {
        label: 'MuJoCo 带球仿真',
        detail: '同一 scene、执行环境与物理配置；公开归档，不是实物。',
        sourceRef: environmentRef,
      },
      sampleSet: {
        label: `${index.episodes.length} 条原场景记录`,
        detail: '保留原计划的全部场景与重复；行数不是独立样本数。',
        sourceRef: archiveRef(
          'sample-set',
          archiveDigest(
            index.episodes
              .map((entry) => inputIdentity(entry.case, run))
              .sort((a, b) => a.ownerStateRef.localeCompare(b.ownerStateRef)),
          ),
        ),
      },
      measurement: { label: '动作触发、接触与躯干运动', detail: MEASUREMENT_DEFINITION, sourceRef: measurementRef },
      groundTruth: {
        label: '仿真真实球位与接触体',
        detail: 'MuJoCo 全知状态，仅适用于此仿真；无视觉感知、无现实或专家 GT。',
        sourceRef: archiveRef('simulator-ground-truth', archiveDigest(index.environment.source)),
        status: 'bounded',
      },
      window: {
        label: `0–${index.plan.durationSeconds} s`,
        detail: '原始物理时间；未变速、未切掉等待。',
        sourceRef: windowIdentity(run),
      },
      exposure: 'public_development',
      limitation: '公开开发归档；没有独立 holdout、正式 Goal、训练或采用。重复 capture 和重复场景均保留。',
      threshold: { status: 'unknown', detail: '正式足球效用门槛尚未冻结；这里只描述本窗口观测。' },
      comparison: {
        design: 'paired',
        method: '同环境、量尺、GT 与时间窗的相同输入作描述性配对；不同样本集必须明确配对范围。',
        planRef: comparisonPlanRef,
      },
      preparationRefs: [{ label: '本次环境、样本与计划原件', ref: sourceRef }],
    },
    metrics: FOOTBALL_METRICS,
  };
}
