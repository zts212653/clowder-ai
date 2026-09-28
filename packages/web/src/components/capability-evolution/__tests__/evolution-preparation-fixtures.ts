import type {
  EvolutionPreparationSection,
  EvolutionPreparationSubmissionRefV1,
  EvolutionPreparationSubmissionV1,
} from '@cat-cafe/shared';
import type {
  EvolutionPreparationProjection,
  EvolutionPreparationSectionProjection,
} from '../preparation/evolution-preparation-resource';
import { ownerRef, PROGRAM_ID } from './evolution-fixtures';

const revisions = {
  object_map: '1',
  success_contract: '2',
  measurement_plan: '9',
  baseline_diagnosis: '4',
} as const;

export function preparationRef(
  section: EvolutionPreparationSection,
  digit: string = revisions[section],
): EvolutionPreparationSubmissionRefV1 {
  return {
    ownerFeatureId: 'F311',
    ownerStateRef: `preparation-submission:${PROGRAM_ID}:${section}`,
    version: `sha256:${digit.repeat(64)}`,
  };
}

function submission(
  section: EvolutionPreparationSection,
  body: EvolutionPreparationSubmissionV1['body'],
  dependsOn: EvolutionPreparationSubmissionRefV1[] = [],
  digit = revisions[section],
): EvolutionPreparationSubmissionV1 {
  return {
    schemaVersion: 1,
    programId: PROGRAM_ID,
    section,
    title: `${section} 准备草案`,
    authorCatId: 'codex-terra',
    revision: `sha256:${digit.repeat(64)}`,
    dependsOn,
    body,
  };
}

const item = (
  itemId: string,
  label: string,
  state: 'unknown' | 'modifiable' | 'partially_modifiable' | 'not_modifiable_this_round' | 'not_applicable',
) => ({
  itemId,
  label,
  scope: `${label}的具体范围`,
  why: `${label}可能影响目标，需要先核查。`,
  modifiability: {
    state,
    reason: state === 'unknown' ? '授权与适用范围尚待核实。' : `${label}边界已按当前轮次核对。`,
    basisRefs: state === 'unknown' ? [] : [ownerRef(`${itemId}-boundary`)],
  },
  sourceRefs: [ownerRef(`${itemId}-source`)],
  nextAction: `继续核查${label}`,
});

export function evolutionPreparationFixture(): EvolutionPreparationProjection {
  const objectMap = submission('object_map', {
    kind: 'object_map',
    goalStatement: '让 PM Agent 专业地推进项目，只在必要时请人介入。',
    summary: '候选不止提示词；当前先核查数据、运行环境与记录入口。',
    items: [
      item('data', '项目数据与反馈', 'modifiable'),
      item('environment', '运行环境', 'not_modifiable_this_round'),
      item('records', '项目记录入口', 'unknown'),
    ],
    unknowns: ['真实业务权限与风险容忍度尚未确认。'],
    nextAction: '完成候选范围核查，再决定首个干预对象。',
  });
  const success = submission(
    'success_contract',
    {
      kind: 'success_contract',
      summary: '六条量尺分开判断，不合成一个看似精确的总分。',
      criteria: [
        ['necessary-intervention', '必要介入', 'business-facts'],
        ['autonomous-closure', '自主闭环', 'business-facts'],
        ['human-burden', '人的负担', 'real-outcomes'],
        ['professional-judgment', '专业判断', 'domain-precedents'],
        ['project-outcome', '项目结果', 'real-outcomes'],
        ['permission-state', '状态与权限', 'business-facts'],
      ].map(([criterionId, label, sourceKey], index) => ({
        criterionId: criterionId as string,
        label: label as string,
        utilityClaim: `${label}必须改善真实项目推进，而不是只改善自评。`,
        observationUnit: '一次有上下文、权限和有效时点的项目推进机会',
        estimator: `按完整机会集核对 ${label}，分母为零时不计算。`,
        counterexample: `日志数量增加，但 ${label} 没有改善。`,
        gtDomain:
          index < 2 ? ('verifiable' as const) : index < 5 ? ('semi_verifiable' as const) : ('open_value' as const),
        judge: index < 2 ? ('verifier' as const) : index < 5 ? ('calibrated_judge' as const) : ('value_owner' as const),
        payer: { kind: index === 2 ? ('human_attention' as const) : ('mixed' as const), detail: '成本仍待业务确认。' },
        gtSourceKeys: [sourceKey as string],
        validityBounds: ['只适用于权限、项目类型与规则版本可比的机会。'],
        unknowns: ['阈值与裁判身份尚未确认。'],
        nextAction: `校准${label}边界判例。`,
      })),
      unknowns: ['业务风险容忍度尚未确认。'],
      nextAction: '请领域 owner 校准边界判例，不要求人工审批技术采集。',
    },
    [preparationRef('object_map')],
  );
  const measurement = submission(
    'measurement_plan',
    {
      kind: 'measurement_plan',
      summary: '来源的采集状态与可信性分别记录。',
      gtSources: [
        {
          sourceKey: 'business-facts',
          category: 'business_fact',
          label: '业务原始事实',
          collection: { state: 'collected', method: '关联原始验收与执行回执。', sourceRef: ownerRef('fact-source') },
          validity: { state: 'needs_review', detail: '已采集，仍待核对缺失与重复回执。' },
          missingOrDisputed: ['失败回执可能缺失。'],
          cost: { payer: '工程维护与业务校核', detail: '预算尚待确认。' },
        },
        {
          sourceKey: 'domain-precedents',
          category: 'domain_precedent',
          label: '领域判断与边界判例',
          collection: { state: 'not_connected', method: '由领域 PM 独立校准。' },
          validity: { state: 'unknown', detail: '裁判身份与适用项目类型未确认。' },
          missingOrDisputed: ['尚无独立判例。'],
          cost: { payer: '领域专家', detail: '专家人时待确认。' },
        },
        {
          sourceKey: 'real-outcomes',
          category: 'real_world_outcome',
          label: '真实使用与后果',
          collection: { state: 'collecting', method: '收集追问、接管与补救事件。' },
          validity: {
            state: 'bounded',
            detail: '仅能回答已发生并有回执的项目机会。',
            validFor: '当前规则版本下有完整事件链的内部项目',
            proofRefs: [ownerRef('outcome-validity')],
          },
          missingOrDisputed: ['沉默不能判为满意。'],
          cost: { payer: '真实用户注意力', detail: '抽样频率与预算待确认。' },
        },
      ],
      conditions: [item('sample', '可比样本', 'partially_modifiable')],
      comparison: {
        unit: '一次项目推进机会',
        primaryVariable: '本轮选定的一个 canonical target 版本',
        controls: ['项目类型', '权限条件', '评估规则版本'],
        developmentEvidence: '公开探索仅用于调试量尺。',
        independentHoldout: '保留未参与候选选择的真实任务。',
        repeatability: '绑定对象、量尺、任务与环境版本。',
      },
      unknowns: ['样本量与采集预算尚未确认。'],
      nextAction: '先接通业务事实并核验可信性。',
    },
    [preparationRef('object_map'), preparationRef('success_contract')],
  );
  const baselineCurrent = submission(
    'baseline_diagnosis',
    {
      kind: 'baseline_diagnosis',
      summary: '当前只能形成初步诊断，不能宣布已经改善。',
      baselineState: 'draft',
      observationUnit: '一次项目推进机会',
      facts: [
        {
          factId: 'handoff-gap',
          label: '有人报告交接遗漏',
          state: 'reported',
          sourceRefs: [ownerRef('handoff-report')],
          limitation: '尚未覆盖无消息的机会。',
        },
      ],
      competingExplanations: [
        {
          explanationId: 'instructions',
          hypothesis: '提示词没有表达责任与升级边界。',
          evidenceFor: [],
          evidenceAgainst: [],
          discriminatingNextStep: '对照相同项目条件下的执行轨迹。',
        },
        {
          explanationId: 'observability',
          hypothesis: 'Agent 无法读到关键项目事件。',
          evidenceFor: [],
          evidenceAgainst: [],
          discriminatingNextStep: '检查事件覆盖与缺失模式。',
        },
      ],
      unknowns: ['基线分母与历史规则版本未知。'],
      nextAction: '补齐机会分母，再区分竞争解释。',
    },
    [preparationRef('success_contract'), preparationRef('measurement_plan', '3')],
  );
  const baselineHistory = {
    ...baselineCurrent,
    title: 'baseline_diagnosis 旧稿',
    revision: `sha256:${'5'.repeat(64)}`,
  };

  const projected = (
    section: EvolutionPreparationSection,
    currentSubmission: EvolutionPreparationSubmissionV1,
    extra: Partial<EvolutionPreparationSectionProjection> = {},
  ): EvolutionPreparationSectionProjection => ({
    section,
    identityRef: { ownerFeatureId: 'F311', ownerStateRef: `preparation-submission:${PROGRAM_ID}:${section}` },
    current: {
      ref: preparationRef(section),
      section,
      status: 'submitted' as const,
      occurredAt: '2026-09-09T08:00:00.000Z',
      clientMessageId: `prepare-${section}`,
      threadId: 'thread-preparation',
      authorCatId: 'codex-terra',
      messageId: `message-${section}`,
      dependencies: currentSubmission.dependsOn,
      staleDependencies: [],
      submission: currentSubmission,
    },
    history: [],
    activities: [],
    ...extra,
  });
  const projectedCurrent = (section: EvolutionPreparationSection, value: EvolutionPreparationSubmissionV1) => {
    const current = projected(section, value).current;
    if (!current) throw new Error('fixture current projection missing');
    return current;
  };

  return {
    schemaVersion: 1,
    programId: PROGRAM_ID,
    sections: {
      object_map: projected('object_map', objectMap, {
        activities: [
          {
            activityRef: { ownerFeatureId: 'F167', ownerStateRef: 'invocation:inv-active-data' },
            section: 'object_map',
            itemId: 'data',
            focus: '核查项目数据与反馈入口',
            baseSubmissionRef: preparationRef('object_map'),
            occurredAt: '2026-09-09T08:10:00.000Z',
            state: 'active',
            spinning: true,
            invocationId: 'inv-active-data',
            threadId: 'thread-preparation',
            catId: 'codex-terra',
          },
        ],
      }),
      success_contract: projected('success_contract', success),
      measurement_plan: projected('measurement_plan', measurement),
      baseline_diagnosis: projected('baseline_diagnosis', baselineCurrent, {
        current: {
          ...projectedCurrent('baseline_diagnosis', baselineCurrent),
          status: 'needs_update',
          staleDependencies: [preparationRef('measurement_plan', '3')],
        },
        history: [
          {
            ...projectedCurrent('baseline_diagnosis', baselineHistory),
            ref: preparationRef('baseline_diagnosis', '5'),
            status: 'needs_update',
            staleDependencies: [preparationRef('measurement_plan', '3')],
            submission: baselineHistory,
          },
        ],
      }),
    },
  };
}
