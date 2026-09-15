import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  type EvolutionPreparationReviewRequestV1,
  type EvolutionResolvedPreparationReviewV1,
  type ExactAssetVersionRefV1,
  evolutionPreparationReviewV1Schema,
  type OwnerTruthRefV1,
} from '@cat-cafe/shared';
import { isMeasuredControlEvaluation, selectedPublicControlSubject } from '../microduck-control-candidate-selection.js';
import {
  MICRODUCK_CONTROL_CANDIDATE_ORDER,
  type MicroduckControlEvaluationReceipt,
  type MicroduckControlExperiment,
  microduckControlEvaluationReceiptSchema,
  microduckControlExperimentSchema,
} from '../microduck-control-evaluation-schemas.js';
import { readMicroduckControlCandidateContract } from '../microduck-control-owner-contract.js';
import type { MicroduckLocalEvidenceOptions } from '../microduck-local-owner-evidence.js';
import { MICRODUCK_OWNER_FEATURE_ID, type MicroduckBlocked } from '../microduck-owner-contract.js';
import { readMicroduckFootballPreparationPublication } from './football-publication.js';

const EXPERIMENT_PATH = 'docs/videos/f311-microduck-roadshow/pipeline/manifests/control-experiment.json';
const PUBLIC_RECEIPT_PATH = 'docs/videos/f311-microduck-roadshow/pipeline/evidence/control-public-evaluation.json';
const FOOTBALL_SMOKE_PATH = 'docs/videos/f311-microduck-roadshow/pipeline/evidence/football-scene-smoke.md';
const FOOTBALL_IMAGE_PATH = 'docs/videos/f311-microduck-roadshow/pipeline/evidence/football-scene-ball-29e887ec.png';
const FOOTBALL_REPORT_SHA256 = '97e8cf1f4989550b96784c43f57c639131550771de8158c273aab03a7f77a264';
const FOOTBALL_IMAGE_SHA256 = '56432b23f095737a3f016f6f5f1d84f1c0f81d283bb1fb0c2386732bb15c220e';
const FOOTBALL_SOURCE_COMMIT = 'bd50ba933054d9c8448cd3b5d3d2794784e4400d';
const CONTROL_PUBLICATION_UPDATED_AT = '2026-09-07T04:36:47.029Z';

type ReadBytes = (path: string) => Promise<Uint8Array>;

export interface MicroduckPreparationPublication {
  status: 'resolved';
  review: EvolutionResolvedPreparationReviewV1;
  candidateVersions: Array<{ versionRef: ExactAssetVersionRefV1; title: string }>;
  sourceRef: OwnerTruthRefV1;
  publicEvaluationRef: OwnerTruthRefV1;
}

const blocked = (code: MicroduckBlocked['code']): MicroduckBlocked => ({ status: 'blocked', code });
const sha256 = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const text = (value: Uint8Array): string => Buffer.from(value).toString('utf8');
const ownerRef = (ownerStateRef: string, version?: string): OwnerTruthRefV1 => ({
  ownerFeatureId: MICRODUCK_OWNER_FEATURE_ID,
  ownerStateRef,
  ...(version ? { version } : {}),
});
const versionRef = (subject: MicroduckControlExperiment['subjects'][number]): ExactAssetVersionRefV1 => ({
  ownerFeatureId: MICRODUCK_OWNER_FEATURE_ID,
  ownerStateRef: subject.artifactRef,
  version: subject.artifactVersion,
  assetKind: 'control-package',
  assetId: subject.id,
});
const fixed = (value: number): string => value.toFixed(6);

async function readFootballMaterial(readBytes: ReadBytes) {
  try {
    const [report, image] = await Promise.all([readBytes(FOOTBALL_SMOKE_PATH), readBytes(FOOTBALL_IMAGE_PATH)]);
    const reportText = text(report);
    const reportHash = sha256(report);
    if (
      reportHash !== FOOTBALL_REPORT_SHA256 ||
      sha256(image) !== FOOTBALL_IMAGE_SHA256 ||
      !reportText.includes('当前 F311 绑定的行走场景没有球') ||
      !reportText.includes('尚未接入 F311 的环境绑定')
    )
      return undefined;
    return {
      materialRef: ownerRef(`repo-material:sha256:${reportHash}`, reportHash),
      title: '带球场景的可复用起点',
      summary:
        '当前 walking runner 绑定的场景没有球；同一上游版本的带球场景已通过编译、球运动与接触 smoke，但尚未接入足球控制或评估。这不是踢球成功。',
      status: 'available' as const,
      facts: [
        { label: '已有产物', value: '带球场景真实渲染，以及编译、运动、接触与球状态读取记录' },
        { label: '还缺什么', value: 'F311 足球环境绑定、球位姿/接触/位移 capture、控制候选与足球评估' },
        { label: '负责角色', value: 'Microduck 环境 owner 与 F311 总交付' },
      ],
      resources: [
        {
          label: '环境 smoke 原文',
          sourceRef: ownerRef(`repo-material:sha256:${reportHash}`, reportHash),
          ownerHref: `https://github.com/zts212653/clowder-ai/blob/${FOOTBALL_SOURCE_COMMIT}/${FOOTBALL_SMOKE_PATH}`,
        },
        {
          label: '真实环境截图',
          sourceRef: ownerRef(`image:sha256:${FOOTBALL_IMAGE_SHA256}`, FOOTBALL_IMAGE_SHA256),
          ownerHref: `https://github.com/zts212653/clowder-ai/blob/${FOOTBALL_SOURCE_COMMIT}/${FOOTBALL_IMAGE_PATH}`,
        },
      ],
    };
  } catch {
    return undefined;
  }
}

function candidateMaterial(
  experiment: MicroduckControlExperiment,
  receipt: MicroduckControlEvaluationReceipt,
  subjectId: (typeof MICRODUCK_CONTROL_CANDIDATE_ORDER)[number],
  experimentRef: OwnerTruthRefV1,
  publicEvaluationRef: OwnerTruthRefV1,
) {
  const subject = experiment.subjects.find((item) => item.id === subjectId);
  const measured = receipt.subjects.find((item) => item.id === subjectId)?.evaluations[0];
  const decision = receipt.publicDecision?.candidates.find((item) => item.subjectId === subjectId);
  if (!subject || !decision || !isMeasuredControlEvaluation(measured)) throw new Error('public candidate missing');
  const selected = receipt.publicDecision?.selectedSubjectId === subjectId;
  const outcome = selected
    ? '公开比较达到预注册门槛，公开预选进入 holdout；密封 holdout 尚未进行，不是正式 winner 或采用。'
    : '公开比较未达到预注册主指标门槛，因此本轮公开筛选未入选；这不是正式审阅拒绝。';
  return {
    materialRef: ownerRef(subject.artifactRef, subject.artifactVersion),
    title: `action_scale = ${subject.actionScale.toFixed(2)}`,
    summary: outcome,
    status: 'available' as const,
    candidateVersionRef: versionRef(subject),
    facts: [
      {
        label: '改了什么',
        value: `只把 action_scale 从 1.00 调为 ${subject.actionScale.toFixed(2)}；ONNX、runner 与环境不变`,
      },
      { label: '为什么提出', value: '预注册的单变量 walking 控制候选，用于检验动作幅度是否改善公开集前向距离' },
      {
        label: '公开对照',
        value: `前向距离 Δ ${fixed(decision.primaryDelta)} m；2×SE 门槛 ${fixed(decision.primaryThreshold)} m；生存率守门 ${decision.guardrailPass ? '通过' : '未通过'}`,
      },
      { label: '取舍', value: outcome },
      { label: '方法记录', value: '候选在看结果前预注册；公开筛选与密封 holdout 分离' },
      {
        label: '后续验证',
        value: selected ? '密封 holdout 尚未进行' : '公开筛选未入选；若重开需新的明确实验理由',
      },
    ],
    resources: [
      { label: '预注册实验', sourceRef: experimentRef },
      { label: '公开评估', sourceRef: publicEvaluationRef },
      { label: '候选配置', sourceRef: ownerRef(subject.configRef, subject.configSha256) },
      ...(measured.captureRef
        ? [{ label: '公开运行 capture', sourceRef: ownerRef(measured.captureRef, measured.captureRef.slice(-64)) }]
        : []),
    ],
  };
}

/** Validates owner files through the existing deployment contract, then projects only public/read truth. */
export async function readMicroduckPreparationPublication(
  options: MicroduckLocalEvidenceOptions,
  input: EvolutionPreparationReviewRequestV1,
  now: () => string,
): Promise<MicroduckPreparationPublication | MicroduckBlocked> {
  const rawRead = options.readBytes ?? (async (path: string) => new Uint8Array(await readFile(path)));
  const cache = new Map<string, Uint8Array>();
  const readBytes: ReadBytes = async (path) => {
    const absolute = resolve(options.repoRoot, path);
    const cached = cache.get(absolute);
    if (cached) return cached;
    const value = await rawRead(absolute);
    cache.set(absolute, value);
    return value;
  };
  const experimentPath = resolve(options.repoRoot, EXPERIMENT_PATH);
  const receiptPath = resolve(options.repoRoot, PUBLIC_RECEIPT_PATH);
  const verified = await readMicroduckControlCandidateContract({ experimentPath, receiptPath, readBytes });
  if (verified.status === 'blocked' && verified.code !== 'holdout_incomplete') return verified;
  try {
    const experiment = microduckControlExperimentSchema.parse(JSON.parse(text(await readBytes(EXPERIMENT_PATH))));
    const receipt = microduckControlEvaluationReceiptSchema.parse(
      JSON.parse(text(await readBytes(PUBLIC_RECEIPT_PATH))),
    );
    const publicSelection = selectedPublicControlSubject(receipt);
    if (
      publicSelection === undefined ||
      receipt.subjects.some((subject) => !isMeasuredControlEvaluation(subject.evaluations[0]))
    )
      return blocked('artifact_hash_mismatch');
    const experimentRef = ownerRef(receipt.experimentRef, receipt.experimentRef.slice(-64));
    const publicEvaluationRef = ownerRef(`public-evaluation:sha256:${receipt.receiptSha256}`, receipt.receiptSha256);
    const football = await readFootballMaterial(readBytes);
    const footballPublication = await readMicroduckFootballPreparationPublication(readBytes);
    const candidates = MICRODUCK_CONTROL_CANDIDATE_ORDER.map((id) =>
      candidateMaterial(experiment, receipt, id, experimentRef, publicEvaluationRef),
    );
    const blockers = [
      {
        code: 'sealed_holdout_not_published',
        ownerRef: ownerRef('evaluation-proof:sealed-holdout:missing'),
      },
      ...(!football
        ? [{ code: 'football_environment_material_unavailable', ownerRef: ownerRef('repo-material:football-smoke') }]
        : []),
      ...(!footballPublication
        ? [{ code: 'football_public_archive_unavailable', ownerRef: ownerRef('repo-material:football-public-archive') }]
        : []),
      { code: 'football_goal_choice_pending', ownerRef: ownerRef('decision:football-goal:pending') },
      { code: 'football_exact_object_unpublished', ownerRef: ownerRef('simulator:football:unpublished') },
    ];
    const review = evolutionPreparationReviewV1Schema.parse({
      schemaVersion: 1,
      status: 'resolved',
      programRef: input.programRef,
      objectRef: input.objectRef,
      sourceRef: footballPublication?.sourceRef ?? experimentRef,
      readAt: now(),
      updatedAt: footballPublication?.updatedAt ?? CONTROL_PUBLICATION_UPDATED_AT,
      groups: [
        {
          groupRef: ownerRef('preparation-group:walking-foundation'),
          title: '已搭好的 walking 评估底座',
          items: [
            {
              materialRef: ownerRef(experiment.evaluationEnvRef, experiment.evaluationEnvSha256),
              title: '当前 walking 评估环境与 runner',
              summary:
                '固定官方 walking ONNX、整机 CPU runner、评估环境与 8 个公开 seed 已按 hash 绑定；当前场景没有球。',
              status: 'available',
              facts: [
                { label: '要搭什么', value: '可复现的环境、runner、单变量配置与公开数据入口' },
                { label: '已有产物', value: '固定 ONNX、runner、环境配置、公开 seed 与每个 subject 的配置 hash' },
                { label: '还缺什么', value: '足球环境绑定和球状态采集；walking 密封 holdout 也尚未发布' },
                { label: '负责角色', value: 'Microduck owner' },
              ],
              resources: [
                { label: '预注册实验', sourceRef: experimentRef },
                {
                  label: '评估环境',
                  sourceRef: ownerRef(experiment.evaluationEnvRef, experiment.evaluationEnvSha256),
                },
                { label: '整机 runner', sourceRef: ownerRef(experiment.runnerRef, experiment.runnerSha256) },
              ],
            },
            {
              materialRef: publicEvaluationRef,
              title: '40 次公开运行与候选筛选',
              summary:
                'baseline、matched control 与 3 个候选各完成 8 次，共 40 次公开运行；结果只用于公开预选，不能当作独立 holdout、正式 winner 或采用。',
              status: 'available',
              facts: [
                { label: '已有产物', value: '5 个 subject × 8 个公开 seed 的 metrics 与 content-addressed captures' },
                { label: '还缺什么', value: '独立密封 holdout、采用决定、加载后的 fresh outcome 与 rollback outcome' },
                { label: '负责角色', value: 'Microduck evaluation owner；采用仍由 F246/operator 决定' },
              ],
              resources: [
                { label: '公开评估 receipt', sourceRef: publicEvaluationRef },
                { label: '预注册比较规则', sourceRef: experimentRef },
              ],
            },
            ...(football
              ? [football]
              : [
                  {
                    materialRef: ownerRef('repo-material:football-smoke'),
                    title: '带球场景材料',
                    summary: '足球环境 smoke 或截图当前无法由 owner 核验；walking 材料仍可阅读。',
                    status: 'unavailable' as const,
                    facts: [{ label: '还缺什么', value: '恢复 exact 环境报告与截图来源' }],
                    resources: [],
                  },
                ]),
          ],
        },
        ...(footballPublication?.groups ?? [
          {
            groupRef: ownerRef('preparation-group:football-public-archive'),
            title: '足球公开归档（新项目尚未建制）',
            items: [
              {
                materialRef: ownerRef('repo-material:football-public-archive'),
                title: '足球公开归档',
                summary: '足球公开归档当前无法由 owner 核验；walking 材料与候选仍可阅读。',
                status: 'unavailable' as const,
                facts: [{ label: '还缺什么', value: '恢复 owner publication manifest 与已公开来源' }],
                resources: [],
              },
            ],
          },
        ]),
        {
          groupRef: ownerRef('preparation-group:public-candidates'),
          title: '公开候选与取舍',
          items: candidates,
        },
      ],
      blockers,
    }) as EvolutionResolvedPreparationReviewV1;
    return {
      status: 'resolved',
      review,
      candidateVersions: candidates.map((candidate) => ({
        versionRef: candidate.candidateVersionRef,
        title: candidate.title,
      })),
      sourceRef: experimentRef,
      publicEvaluationRef,
    };
  } catch {
    return blocked('artifact_hash_mismatch');
  }
}
