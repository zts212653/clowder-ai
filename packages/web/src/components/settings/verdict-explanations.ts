/**
 * F257 #6 (slice 6a) — Canonical verdict vocabulary explanations (判据 ③).
 *
 * The segment lifeline eval verdict is one of the frozen `SegmentVerdict` values
 * (judgment-schema-v1 §2), produced by segment-judgment-engine and carried on
 * `EvalStageSummary.verdict`. Before this, the lifeline UI hard-coded only
 * alive/dormant/retire-candidate, so `observability-debt` / `needs-denominator` /
 * `unmeasurable` rendered as a default amber with NO explanation (operator
 * screenshot: `eval(unmeasurable)` with its meaning never surfaced).
 *
 * This module is the single source of truth for verdict → { label, explanation,
 * tone }. `VERDICT_EXPLANATIONS satisfies Record<SegmentVerdict, …>` makes a new
 * verdict fail closed at compile time — the vocabulary can never silently drift
 * from the engine again (sol R1 P2-1).
 *
 * Domain note: this is the SEGMENT verdict — NOT the Eval Hub verdict-handoff
 * vocabulary (fix | build | keep_observe | delete_sunset). Those are unrelated.
 */

import { SEGMENT_VERDICTS, type SegmentVerdict } from '@cat-cafe/shared';

export type VerdictTone = 'emerald' | 'amber' | 'red' | 'blue' | 'slate';

export interface VerdictExplanation {
  /** Short Chinese display label. */
  label: string;
  /** One-line Chinese explanation of what this verdict means for the segment. */
  explanation: string;
  tone: VerdictTone;
}

/**
 * Explanation for every canonical SegmentVerdict. Semantics are the frozen
 * judgment-schema-v1 §2 rules — do not paraphrase across domains (sol R1 P1-2).
 * `satisfies` guarantees this covers exactly the SegmentVerdict union.
 */
export const VERDICT_EXPLANATIONS = {
  alive: {
    label: '活跃',
    explanation:
      '有注入分母（injectionCount>0），违规率可计算——即使零违规也是合法 alive（区别于无分母的 unmeasurable），段正常服役。',
    tone: 'emerald',
  },
  dormant: {
    label: '休眠',
    explanation: '有分母、且连续 2 个评估周期零触发零违规——疑似冗余，进入退役候选观察。',
    tone: 'amber',
  },
  unmeasurable: {
    label: '无分母',
    explanation: '窗口内无注入分母（injectionCount=0），本窗口不可判——铁律禁止据此判休眠（防错杀）。',
    tone: 'slate',
  },
  'observability-debt': {
    label: '观测债',
    explanation: '观测链路自身断裂——该段的 trace/eval 观测采集不到，段状态不可知；需修复观测链路后才能重新评估。',
    tone: 'red',
  },
  'needs-denominator': {
    label: '待补分母',
    explanation:
      '分母可补但尚未补齐——接入可计算的注入/会话分母（fired-count / session-count）后即可评估；区别于「无分母」当窗彻底不可判。',
    tone: 'blue',
  },
  'retire-candidate': {
    label: '退役候选',
    explanation: '满足三级政策第③级——等 operator 批准进入退役队列。',
    tone: 'red',
  },
} satisfies Record<SegmentVerdict, VerdictExplanation>;

/** The canonical verdict vocabulary (re-export of the shared tuple, for tests/iteration). */
export const KNOWN_VERDICTS: readonly SegmentVerdict[] = SEGMENT_VERDICTS;

/**
 * Resolve a verdict string to its explanation. A null/absent verdict maps to an
 * explicit "未评估" entry; an unknown verdict (should be unreachable given the typed
 * contract, but the value crosses a JSON boundary) degrades visibly — raw label +
 * a "please register" explanation — so it can never silently render blank.
 */
export function explainVerdict(verdict: string | null | undefined): VerdictExplanation {
  if (!verdict) {
    return { label: '未评估', explanation: '该版本尚未产生评估判定。', tone: 'slate' };
  }
  return (
    (VERDICT_EXPLANATIONS as Record<string, VerdictExplanation>)[verdict] ?? {
      label: verdict,
      explanation:
        '未知判定词——评估层新增了词汇但 Console 尚未登记解释，请补充 SEGMENT_VERDICTS + VERDICT_EXPLANATIONS。',
      tone: 'slate',
    }
  );
}
