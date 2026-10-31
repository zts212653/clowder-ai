import { createHash } from 'node:crypto';
import {
  type EvolutionExplorationConditionsV1,
  type EvolutionExplorationExperimentV1,
  type EvolutionExplorationRecordV1,
  type EvolutionExplorationSelectionV1,
  type EvolutionResolvedExplorationReviewV1,
  evolutionExplorationReviewV1Schema,
  evolutionExplorationSelectionMatches,
  refIdentity,
} from '@cat-cafe/shared';
import * as conditionsModule from '../../src/components/capability-evolution/solution-gate/duck-demo/demo-conditions';
import type { DemoRun, MemberId } from '../../src/components/capability-evolution/solution-gate/duck-demo/demo-data';
import * as dataModule from '../../src/components/capability-evolution/solution-gate/duck-demo/demo-data';

// Web TypeScript is CJS under Node/tsx and ESM under Vite; preserve the same exported fixture.
const { caseInputs, environment } =
  (conditionsModule as unknown as { default?: typeof conditionsModule }).default ?? conditionsModule;
const { caseSets, demoRuns, evaluations, eventPacket, memberNames, versions } =
  (dataModule as unknown as { default?: typeof dataModule }).default ?? dataModule;

export const MOCK_PROGRAM_ID = 'evolution-program:31103110311031103110311031103110';
export const mockRef = (name: string, content: unknown = name) => ({
  ownerFeatureId: 'F311',
  ownerStateRef: `mock-duck:${name}`,
  version: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
});
export const mockObject = mockRef('simulation-only');
const programRef = { ownerFeatureId: 'F311', ownerStateRef: MOCK_PROGRAM_ID };
const versionCopy = {
  V1: ['起点', '先跑六个场景，记录鸭鸭能否触球。为什么：先沿观察、指令、摆位和起脚找失败位置；能触球不等于能进球。'],
  V2: [
    '持续跟球',
    '一起调整持续跟球的控制逻辑和摆位参数，模型与协议保持不变。为什么：鸭停下时球还在滚，先试成本较低、贴近失败位置的改动；两项贡献暂不拆分。',
  ],
  V3: [
    '看清进球',
    '保留原来的控制，补上整球越线观测与有效进球判法。为什么：碰到球也可能踢偏，原来的触球成绩回答不了进没进球。',
  ],
  V4: [
    '合并重测',
    '把持续跟球与摆位调整，和新的越线观测、进球判法合在一起。为什么：需要在同样场景、同一判法下与旧控制比较，才能判断多触球是否换来更多进球。',
  ],
};
const runCopy: Record<string, string> = {
  X1: '原控制·触球',
  X2: '新控制·触球',
  X3: '加载不符·中止',
  X4: '原控制·进球',
  X5: '新控制·进球',
  X6: '原控制·左侧新例',
  X7: '新控制·左侧新例',
};
const changeCopy: Record<string, string> = {
  V1: '建立触球基线，记录六种来球下的动作。',
  V2: '持续跟踪移动球，配合调整脚踝摆位。',
  V3: '保留原控制，增加越线观测和有效进球判法。',
  V4: '合并跟球控制、越线观测与进球判法，同尺重测。',
};
const nodes = versions.map((v) => {
  const parent = versions.find((p) => p.id === v.parents[0]);
  return {
    kind: 'public_archive' as const,
    nodeRef: mockRef(v.id, v),
    title: `${v.id} · ${versionCopy[v.id][0]}`,
    summary: versionCopy[v.id][1],
    sourceRef: mockRef(`manifest-${v.id}`, v),
    changes: [
      { label: '改了什么', detail: changeCopy[v.id], sourceRef: mockRef(`manifest-${v.id}`, v) },
      { label: '成员版本差异', detail: v.change, sourceRef: mockRef(`manifest-${v.id}`, v) },
      { label: '选择理由', detail: v.why, sourceRef: mockRef(`manifest-${v.id}`, v) },
      { label: '结果与边界（模拟）', detail: v.limit, sourceRef: mockRef(`manifest-${v.id}`, v) },
      ...(Object.keys(memberNames) as MemberId[]).map((id) => ({
        label: memberNames[id],
        detail: `${parent && parent.members[id] !== v.members[id] ? `${parent.members[id]} → ` : ''}${v.members[id]}；${v.id === 'V4' && ['observation', 'rubric'].includes(id) ? '来自 V3 分支' : '模拟成员版本'}。`,
        sourceRef: mockRef(`${v.id}-${id}`, v.members[id]),
      })),
    ],
    parentEdges: v.parents.map((id) => ({
      parentNodeRef: mockRef(
        id,
        versions.find((p) => p.id === id),
      ),
      sourceRef: mockRef(`edge-${id}-${v.id}`, { from: id, to: v.id, members: v.members }),
    })),
  };
});
function conditions(run: DemoRun): EvolutionExplorationConditionsV1 {
  const rule = evaluations[run.evaluation as keyof typeof evaluations];
  const condition = (label: string, detail: string, name: string, value: unknown) => ({
    label,
    detail,
    sourceRef: mockRef(name, value),
  });
  return {
    environment: condition('E1 · 模拟球场', JSON.stringify(environment), 'E1', environment),
    sampleSet: condition(
      `${run.sampleSet} · ${caseSets[run.sampleSet].length}个${run.sampleSet === 'D1' ? '公开开发' : '新左侧'}模拟输入`,
      `${JSON.stringify(caseInputs[run.sampleSet])}，每行[x,y,vx,vy]，成对使用同一初态；${run.sampleSet === 'D1' ? '已用于改法选择' : '候选冻结后第一次使用，仍是编写的演示数据'}`,
      run.sampleSet,
      caseInputs[run.sampleSet],
    ),
    measurement: condition(
      `${rule.title} · ${run.evaluation}`,
      `评估${run.evaluation} / 观测${run.observation} / 规约${rule.rubric}。${rule.sees} ${rule.rule} ${rule.verifier}`,
      run.evaluation,
      rule,
    ),
    groundTruth: {
      ...condition(
        '模拟事件 · 无真实 GT',
        `${rule.observation}：${rule.sees} 本次只验证展示链路，编写的结果不证明真实鸭鸭能力。`,
        `gt-${run.evaluation}`,
        rule,
      ),
      status: 'unverified',
    },
    window: condition('0–26 秒 · 相同观察窗', '每个案例固定26秒；失败和未尝试都保留。', 'window26', 26),
    exposure: 'public_development',
    limitation: `全为mock。加载：${run.loaded ? `模拟回执逐项匹配${run.scheme}` : '计划H2、实际H1；已中止，不归属V2成绩'}。成本${run.minutes}分钟（模拟）。O1缺越线记录，不能按R2重判旧X1；J1/R1保留。两个改动的各自贡献未知。`,
    threshold: {
      status: 'frozen',
      detail: `模拟判据：${rule.rule} 不构成真实效用通过。`,
      sourceRef: mockRef(rule.rubric, rule.rule),
    },
    comparison: {
      design: 'paired',
      method: '在相同E1/26秒/观测/规约下逐一配对输入；保留失败与回归，不跨尺拼接成绩。',
      planRef: mockRef(`paired-${run.evaluation}`, rule),
    },
    preparationRefs: [
      {
        label: '模拟评估方案与组成原件',
        ref: mockRef(`packet-${run.id}`, run),
        href: `/api/mock-duck/source/${run.id}`,
      },
    ],
  };
}
const experiments: EvolutionExplorationExperimentV1[] = demoRuns.map((run) => ({
  experimentRef: mockRef(run.id, run),
  nodeRef: nodes.find((n) => n.title.startsWith(run.scheme))!.nodeRef,
  sourceRef: mockRef(`run-${run.id}`, run),
  title: `${run.id} · ${runCopy[run.id]}`,
  status: run.loaded ? 'recorded' : 'failed',
  recordCount: run.contact?.length ?? 0,
  conditions: conditions(run),
  metrics: [
    {
      key: 'contact',
      label: '模拟指定脚触球',
      unit: '0/1',
      definition: '指定脚在踢球动作期触球记1；未触球记0。全部为编写的案例。',
      sourceRef: mockRef('contact-definition'),
    },
    {
      key: 'goal',
      label: '模拟有效进球',
      unit: '0/1',
      definition: '合法触球后整球越线记1；无越线观测保留未知。全部为编写的案例。',
      sourceRef: mockRef('goal-definition'),
    },
  ],
}));
function records(run: DemoRun): EvolutionExplorationRecordV1[] {
  const experiment = experiments.find((e) => e.title.startsWith(`${run.id} ·`))!;
  if (!run.loaded || !run.contact) return [];
  return run.contact.map((hit, i) => {
    const packet = eventPacket(run, i),
      evidence = mockRef(`event-${run.id}-${i}`, packet);
    const passed = run.goals ? run.goals[i] : hit;
    return {
      recordRef: mockRef(`record-${run.id}-${i}`, packet),
      experimentRef: experiment.experimentRef,
      nodeRef: experiment.nodeRef,
      caseId: `${run.sampleSet}-${i}`,
      label: `${caseSets[run.sampleSet][i]} · 模拟`,
      inputRef: mockRef(`input-${run.sampleSet}-${i}`, caseInputs[run.sampleSet][i]),
      evidenceRef: evidence,
      windowRef: experiment.conditions.window.sourceRef,
      measurementRef: experiment.conditions.measurement.sourceRef,
      input: [
        { label: '数据性质', value: '人工编写mock，不是物理仿真或真实训练结果' },
        { label: '初始x/y/vx/vy', value: JSON.stringify(caseInputs[run.sampleSet][i]) },
        { label: '观测 / 评估', value: `${run.observation} / ${run.evaluation}` },
      ],
      output: [
        { label: '模拟事件', value: JSON.stringify(packet) },
        { label: '方案成员加载（模拟）', value: JSON.stringify(versions.find((v) => v.id === run.scheme)?.members) },
        { label: '本轮试跑成本（模拟）', value: `${run.minutes}分钟` },
      ],
      result: {
        status: passed ? 'satisfied' : 'violated',
        label: `模拟：${run.goals ? '有效进球' : '指定脚触球'}${passed ? '满足' : '未满足'}`,
      },
      values: { contact: Number(hit), goal: run.goals ? Number(run.goals[i]) : null },
      media: [],
      sources: [{ label: '本场模拟原始事件', ref: evidence, href: `/api/mock-duck/source/${run.id}?case=${i}` }],
    };
  });
}
export function mockExploration(selection: EvolutionExplorationSelectionV1 = {}): EvolutionResolvedExplorationReviewV1 {
  const selected = new Set(
    [selection.selectedExperimentRef, selection.comparisonExperimentRef].filter(Boolean).map((r) => refIdentity(r!)),
  );
  const review = {
    schemaVersion: 1 as const,
    programRef,
    objectRef: mockObject,
    status: 'resolved' as const,
    sourceRef: mockRef('mock-publication', { versions, demoRuns }),
    readAt: '2026-09-20T01:50:00.000Z',
    nodes,
    experiments,
    details: experiments
      .filter((e) => selected.has(refIdentity(e.experimentRef)))
      .map((e) => ({
        status: 'resolved' as const,
        experimentRef: e.experimentRef,
        nodeRef: e.nodeRef,
        records: records(demoRuns.find((r) => e.title.startsWith(`${r.id} ·`))!),
      })),
    blockers: [],
  };
  const parsed = evolutionExplorationReviewV1Schema.parse(review);
  if (parsed.status !== 'resolved' || !evolutionExplorationSelectionMatches(parsed, selection))
    throw Error('Unknown or mismatched mock selection');
  return parsed;
}
export function mockSource(runId: string, index?: number) {
  const run = demoRuns.find((r) => r.id === runId);
  if (!run) throw Error('Unknown mock run');
  return {
    truth: 'mock_only',
    run,
    version: versions.find((v) => v.id === run.scheme),
    conditions: conditions(run),
    ...(index === undefined ? {} : { event: eventPacket(run, index) }),
  };
}
