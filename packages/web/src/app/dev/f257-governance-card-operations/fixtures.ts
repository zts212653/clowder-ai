import type { HarnessGovernanceProposalChange } from '@cat-cafe/shared';

/**
 * F257 governance action fixtures.
 *
 * Kept out of page.tsx because a Next App Router page may only export the
 * route contract; the contract test next door imports these directly so the
 * page and the guard can never drift apart.
 */

/**
 * add → HarnessUnitDirectoryWriter creates `<assetSlug>/<template>` and
 * `<assetSlug>/hook.yaml`, then APPENDS one entry to the existing
 * docs/harness-feedback/objectives/unit-evaluation-manifest.yaml.
 * hookId = unitId (HarnessGovernanceExecutor.hydrateAdd), not the slug.
 */
export const ADD_CHANGE = {
  action: 'add',
  unitId: 'D22',
  hookId: 'D22',
  assetSlug: 'd22-termination-gate',
  reason: '补入可验证的终止出口门',
  manifest: {
    id: 'D22',
    name: '终止门',
    stage: 'per-turn',
    // per-turn is occupied contiguously to 2400 (R1@2200, R2@2300, N1@2400);
    // HarnessGovernanceExecutor.validateAdd rejects a duplicate stage/order.
    order: 2500,
    version: 1,
    enabled: true,
    template: 'content.md',
    inputs: ['threadId'],
    // The newline and the ": " both exercise reversible scalar encoding.
    variables: [{ name: 'catId', description: '当前 invocation 的猫\n第二行: 这不是新键' }],
    disableable: true,
    safetyTier: 'editable',
    transparencyTier: 'visible-by-default',
    governanceTier: 'human-gated',
  },
  content: '# 终止门\n\n每轮结束前必须给出可验证的终止出口。',
  objectives: [{ objectiveId: 'tool-access-correct-use' }],
} satisfies HarnessGovernanceProposalChange;

/**
 * disable → runtime override only; the body is NOT deleted.
 * Target is D9, not L4: l4-五条铁律/hook.yaml declares `disableable: false` and
 * HarnessGovernanceExecutor throws cycle_governance_disable_forbidden before
 * emitting the change, so an L4 disable card cannot exist.
 */
export const DISABLE_CHANGE = {
  action: 'disable',
  unitId: 'D9',
  hookId: 'D9',
  reason: '消融验证路由反馈段是否仍有必要',
  beforeEnabled: true,
  beforeContent: '收到 @ 后必须三选一：接 / 退 / 升。\n状态描述不是球权声明。',
  objectiveImpact: { objectiveId: 'routing-target-delivery', remainingMemberCount: 4 },
} satisfies HarnessGovernanceProposalChange;

/** enable on an already-enabled unit — the executor does NOT reject this. */
export const ENABLE_NOOP_CHANGE = {
  action: 'enable',
  unitId: 'L4',
  hookId: 'L4',
  reason: '重新启用（当前已启用 —— 这是一次空操作）',
  beforeEnabled: true,
  beforeContent: '1. **Runtime data safety** — 用隔离的开发/测试数据存储。',
  objectiveImpact: { objectiveId: 'iron-law-compliance', remainingMemberCount: 0 },
} satisfies HarnessGovernanceProposalChange;

/** modify → content override in the runtime store; no file path is knowable. */
export const MODIFY_CHANGE = {
  action: 'modify',
  unitId: 'D8',
  hookId: 'D8',
  reason: '保留原规则并补入终止出口门',
  sourceVersion: 1,
  beforeContent: '<!-- D8 -->\n\n现有球权规则。\n',
  proposedContent: '<!-- D8 -->\n\n现有球权规则。\n\n新增终止门：每轮必须给出可验证出口。',
  beforeCondition: null,
} satisfies HarnessGovernanceProposalChange;

export const SCENARIOS = [
  {
    id: 'add',
    title: '新增段 D22',
    hint: '两个新建文件 + 注册表追加：三块应各自标注「新建文件 / 新建文件 / 在既有文件中追加注册项」，并显示三条真实仓库路径',
    change: ADD_CHANGE,
  },
  {
    id: 'disable',
    title: '禁用段 D9',
    hint: '只写运行时 store：两块都应标「运行时状态（不写文件）」，正文两侧相等，且不出现文件路径或 “file changed”',
    change: DISABLE_CHANGE,
  },
  {
    id: 'enable-noop',
    title: '启用段 L4（空操作）',
    hint: '当前已启用：启用状态两侧应完全相同，整屏零增删 —— 读起来就是一次空操作',
    change: ENABLE_NOOP_CHANGE,
  },
  {
    id: 'modify',
    title: '修改段 D8',
    hint: '原文保留为上下文、只把新增段落标绿；现有段目录不可从卡片推导，故不显示文件头',
    change: MODIFY_CHANGE,
  },
] as const;
