import type { CapabilityName, CapabilityWakeupRule } from './eval-capability-wakeup-types.js';

/**
 * F192 Phase H 收尾 PR-2 — static capability-wakeup rule registry (砚砚 R1 P2).
 *
 * Why static (not loaded from yaml): `eval-capability-wakeup.yaml` carries only
 * domain metadata + fixtures, NOT rule definitions (砚砚 R1 Q2 confirmed). Rules
 * live in code so type-checked predicate shapes (the 4 CapabilityPredicate variants)
 * can't drift from runtime parsing.
 *
 * 砚砚 R1 P2 lock: MUST cover the 3 capabilities the normalizer already classifies
 * (rich-messaging / workspace-navigator / browser-preview). Less = domain instruction
 * says prioritize workspace-navigator but publish only supports rich → new
 * 501/empty-trials bug variant.
 *
 * Tuning: predicates here are minimum viable rules — production refinement
 * (threshold calibration, false-positive trimming) happens as real verdicts
 * accumulate and Eval Hub miss-rate informs adjustments.
 */
export const DEFAULT_CAPABILITY_WAKEUP_RULES: CapabilityWakeupRule[] = [
  // rich-messaging — original rule from PR-1a's submitted-packet test fixture
  {
    id: 'rich-messaging-long-structured-text',
    capability: 'rich-messaging',
    predicate: {
      type: 'multi_msg_text_volume_threshold',
      capability: 'rich-messaging',
      // PR-2 placeholder thresholds — production calibration TBD as real verdicts
      // inform tuning. estimateTokens = chars/4, so 50 tokens ≈ 200-char paragraph
      // with 3 structured signals (bullets/code-blocks/table rows).
      minTokenCount: 50,
      minStructuredSignals: 3,
    },
  },

  // workspace-navigator — text patterns where cat should open files/dirs to show co-creator
  // 砚砚 R1 P1 PR-2 review: `text_pattern_then_capability` evaluator uses
  // `patterns.every(...)` (AND semantics) — multi-element array requires ALL phrases
  // in same transcript, effectively unmatchable. Fix: single regex with alternation.
  // (Trial fires when transcript hints user wants visual context but cat hasn't navigated.)
  {
    id: 'workspace-navigator-show-file-request',
    capability: 'workspace-navigator',
    predicate: {
      type: 'text_pattern_then_capability',
      capability: 'workspace-navigator',
      patterns: ['打开|看看代码|看看文件|查看文件|帮我打开|open the (file|dir|directory)|show me the (file|code)'],
    },
  },

  // browser-preview — text patterns where cat should preview a frontend page
  // Same alternation pattern (砚砚 R1 P1 PR-2 review fix).
  {
    id: 'browser-preview-see-effect-request',
    capability: 'browser-preview',
    predicate: {
      type: 'text_pattern_then_capability',
      capability: 'browser-preview',
      patterns: ['看看效果|看下页面|运行起来看|preview the (page|frontend|ui)|see the (result|effect)'],
    },
  },
  textRule(
    'image-generation-visual-asset-request',
    'image-generation',
    '需要图|生成图片|生图|配图|架构图|视觉 mock|visual asset|generate (an )?image',
  ),
  textRule(
    'pencil-design-ui-design-request',
    'pencil-design',
    '设计稿|高保真|\\.pen\\b|Pencil|UI 设计|视觉探索|design file|design mock',
  ),
  textRule(
    'guide-interaction-how-to-request',
    'guide-interaction',
    '怎么用|怎么配置|如何操作|新手引导|配置流程|how to (use|configure)|onboarding',
  ),
  textRule(
    'expert-panel-multi-perspective-request',
    'expert-panel',
    '多猫|专家团|多视角|辩论|架构决定|brainstorm|expert panel',
  ),
  textRule(
    'propose-thread-new-scope-request',
    'propose-thread',
    '另开.*thread|新 thread|开个 thread|独立调查|子任务.*context|propose thread',
  ),
  textRule(
    'external-runtime-sessions-lost-session',
    'external-runtime-sessions',
    '外部 runtime|Antigravity|IDE-direct|会话.*丢|截图给我看|runtime session',
  ),
  textRule(
    'cli-diagnostics-exit-debug',
    'cli-diagnostics',
    'CLI.*退出|退出了|debugRef|cliDiagnostics|stderr|子进程.*退出|cli diagnostics',
  ),
  textRule(
    'eval-verdict-harness-closure',
    'eval-verdict',
    'eval hub|verdict|评估报告|harness.*修了|publish_verdict|re-eval|闭环证据',
  ),
  textRule(
    'memory-drilldown-recall-source',
    'memory-drilldown',
    '压缩后失忆|旧决策|哪里.*说过|找.*源头|session.*digest|read_session|drill.?down',
  ),
  textRule(
    'update-workflow-stage-handoff',
    'update-workflow',
    '阶段进度|下一棒|告示牌|workflow|Mission Control|update_workflow|stage status',
  ),
];

function textRule(id: string, capability: CapabilityName, pattern: string): CapabilityWakeupRule {
  return {
    id,
    capability,
    predicate: {
      type: 'text_pattern_then_capability',
      capability,
      patterns: [pattern],
    },
  };
}

export interface CapabilityWakeupRulesFilter {
  capability?: CapabilityName | string;
  /** Empty array treated as "no narrowing" (returns all rules matching capability filter). */
  ruleIds?: string[];
}

/**
 * Filter the static registry by capability and/or ruleIds (intersection — both must match).
 *
 * Empty `ruleIds` array treated as "no narrowing" (consistent with capability=undefined behavior).
 * Non-empty `ruleIds` with no matches → empty result (no implicit fallback).
 */
export function getCapabilityWakeupRules(filter: CapabilityWakeupRulesFilter = {}): CapabilityWakeupRule[] {
  let rules = DEFAULT_CAPABILITY_WAKEUP_RULES;
  if (filter.capability !== undefined) {
    rules = rules.filter((r) => r.capability === filter.capability);
  }
  if (filter.ruleIds !== undefined && filter.ruleIds.length > 0) {
    const wanted = new Set(filter.ruleIds);
    rules = rules.filter((r) => wanted.has(r.id));
  }
  return rules;
}
