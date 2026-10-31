import { type AssetVersionRefV1, assetRefIdentity, type OwnerTruthRefV1, refIdentity } from '@cat-cafe/shared';
import { collectForeignOwnership, type EvolutionEvalReason, evalReason } from './eval-reasons.js';

/**
 * F311 Phase 3 — changing the ruler invalidates the comparison until it is re-earned (AC-32).
 *
 * A rubric version move may only be declared comparable after either a complete old/new-rubric ×
 * old/new-candidate rejudge on the SAME frozen cohort, or an owner-side baseline rebuild. Anything
 * else is `incomparable`, and splicing old and new scores stays forbidden.
 */

export type RubricComparabilityMode = 'unchanged' | 'two_by_two_rejudge' | 'baseline_rebuild' | 'none';
export type RejudgeAxis = 'previous' | 'current';

export interface RejudgeCell {
  rubric: RejudgeAxis;
  candidate: RejudgeAxis;
  resultRef: OwnerTruthRefV1;
}

export interface RubricComparabilityInput {
  frozenCohortRef: OwnerTruthRefV1;
  previousRubricRef: AssetVersionRefV1;
  currentRubricRef: AssetVersionRefV1;
  rejudge?: { frozenCohortRef: OwnerTruthRefV1; cells: RejudgeCell[] };
  baselineRebuildRef?: OwnerTruthRefV1;
}

export interface RubricComparabilityAssessment {
  comparability: 'comparable' | 'incomparable';
  mode: RubricComparabilityMode;
  /** True only when the ruler never moved; a rejudge proves comparability, not score splicing. */
  spliceAllowed: boolean;
  missingCells: Array<{ rubric: RejudgeAxis; candidate: RejudgeAxis }>;
  reasons: EvolutionEvalReason[];
  evidenceRefs: OwnerTruthRefV1[];
}

const REJUDGE_MATRIX: Array<{ rubric: RejudgeAxis; candidate: RejudgeAxis }> = [
  { rubric: 'previous', candidate: 'previous' },
  { rubric: 'previous', candidate: 'current' },
  { rubric: 'current', candidate: 'previous' },
  { rubric: 'current', candidate: 'current' },
];

/**
 * Full identity, owner included. A rubric that changed hands is a different ruler even if the
 * asset id and version happen to match.
 */
function rubricMoved(previous: AssetVersionRefV1, current: AssetVersionRefV1): boolean {
  return assetRefIdentity(previous) !== assetRefIdentity(current);
}

const sameRef = (left: AssetVersionRefV1, right: AssetVersionRefV1): boolean =>
  assetRefIdentity(left) === assetRefIdentity(right);

/**
 * A rubric with no declared version can never prove "unchanged" — two unversioned refs compare
 * equal by accident, which is exactly how an unnoticed ruler swap slips through.
 */
function versionReasons(input: RubricComparabilityInput): EvolutionEvalReason[] {
  return (
    [
      ['previous rubric', input.previousRubricRef],
      ['current rubric', input.currentRubricRef],
    ] as const
  )
    .filter(([, ref]) => ref.version === undefined)
    .map(([label, ref]) => evalReason('rubric_version_missing', ref, label));
}

function rejudgeReasons(
  input: RubricComparabilityInput,
  rejudge: NonNullable<RubricComparabilityInput['rejudge']>,
): { reasons: EvolutionEvalReason[]; missingCells: RubricComparabilityAssessment['missingCells'] } {
  const reasons: EvolutionEvalReason[] = [];
  const missingCells = REJUDGE_MATRIX.filter(
    (cell) => !rejudge.cells.some((entry) => entry.rubric === cell.rubric && entry.candidate === cell.candidate),
  );
  if (refIdentity(rejudge.frozenCohortRef) !== refIdentity(input.frozenCohortRef)) {
    reasons.push(evalReason('rejudge_cohort_drift', rejudge.frozenCohortRef));
  }
  if (missingCells.length > 0) {
    reasons.push(evalReason('rejudge_incomplete', input.frozenCohortRef, `缺 ${missingCells.length} 格`));
  }
  const resultRefs = rejudge.cells.map((cell) => refIdentity(cell.resultRef));
  if (new Set(resultRefs).size !== resultRefs.length) {
    reasons.push(evalReason('rejudge_cell_reused', input.frozenCohortRef));
  }
  const coordinates = rejudge.cells.map((cell) => `${cell.rubric}\u0000${cell.candidate}`);
  if (new Set(coordinates).size !== coordinates.length) {
    reasons.push(evalReason('rejudge_duplicate_cell', input.frozenCohortRef));
  }
  reasons.push(
    ...collectForeignOwnership(
      rejudge.cells.map((cell) => [`${cell.rubric}/${cell.candidate} 复判结果`, cell.resultRef]),
    ),
  );
  return { reasons, missingCells };
}

export function assessRubricComparability(input: RubricComparabilityInput): RubricComparabilityAssessment {
  const evidenceRefs: OwnerTruthRefV1[] = [
    input.frozenCohortRef,
    input.previousRubricRef,
    ...(sameRef(input.previousRubricRef, input.currentRubricRef) ? [] : [input.currentRubricRef]),
  ];
  // Hard reasons apply to every branch: an unowned or unversioned ruler can never be comparable.
  const hard = [
    ...collectForeignOwnership([
      ['frozen cohort', input.frozenCohortRef],
      ['baseline rebuild', input.baselineRebuildRef],
      ['previous rubric', input.previousRubricRef],
      ['current rubric', input.currentRubricRef],
    ]),
    ...versionReasons(input),
  ];

  const incomparable = (
    mode: RubricComparabilityMode,
    reasons: EvolutionEvalReason[],
    missingCells: RubricComparabilityAssessment['missingCells'],
    evidence: OwnerTruthRefV1[],
  ): RubricComparabilityAssessment => ({
    comparability: 'incomparable',
    mode,
    spliceAllowed: false,
    missingCells,
    reasons,
    evidenceRefs: evidence,
  });

  if (hard.length === 0 && !rubricMoved(input.previousRubricRef, input.currentRubricRef)) {
    return {
      comparability: 'comparable',
      mode: 'unchanged',
      spliceAllowed: true,
      missingCells: [],
      reasons: [],
      evidenceRefs,
    };
  }
  if (input.baselineRebuildRef !== undefined) {
    const evidence = [...evidenceRefs, input.baselineRebuildRef];
    if (hard.length > 0) return incomparable('baseline_rebuild', hard, [], evidence);
    return {
      comparability: 'comparable',
      mode: 'baseline_rebuild',
      spliceAllowed: false,
      missingCells: [],
      reasons: [],
      evidenceRefs: evidence,
    };
  }
  if (input.rejudge !== undefined) {
    const { reasons, missingCells } = rejudgeReasons(input, input.rejudge);
    const allReasons = [...hard, ...reasons];
    const evidence = [...evidenceRefs, ...input.rejudge.cells.map((cell) => cell.resultRef)];
    if (allReasons.length > 0) return incomparable('two_by_two_rejudge', allReasons, missingCells, evidence);
    return {
      comparability: 'comparable',
      mode: 'two_by_two_rejudge',
      spliceAllowed: false,
      missingCells: [],
      reasons: [],
      evidenceRefs: evidence,
    };
  }
  return incomparable(
    'none',
    [
      ...hard,
      // Only claim the ruler moved when both versions are actually known.
      ...(versionReasons(input).length > 0
        ? []
        : [evalReason('rubric_version_changed_without_rejudge', input.currentRubricRef)]),
    ],
    REJUDGE_MATRIX,
    evidenceRefs,
  );
}
