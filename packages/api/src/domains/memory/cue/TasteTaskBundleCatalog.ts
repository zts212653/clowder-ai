export const TASTE_TASK_BUNDLE_SOURCE_ANCHOR_PREFIX = 'taste-task-bundle:';
export const MAX_TASTE_TASK_BUNDLE_REFS = 4;

const PUBLIC_TASTE_DIRECTORY_PREFIX = 'docs/taste/vignettes/';

export interface TasteTaskBundlePredicate {
  readonly featureId: string;
  readonly stage: 'quality_gate' | 'review';
  readonly selectedSkill: 'writing-plans' | 'co-creation-docs' | 'fresh-context-review' | 'request-review';
}

export interface TasteTaskBundleDefinition extends TasteTaskBundlePredicate {
  readonly bundleId: string;
  readonly consumerTaskRef: string;
  readonly sourcePaths: readonly string[];
}

/** F316 AC-C2: a real, owner-tracked UI review; not a generic topic match. */
export const F315_WORKSPACE_READABILITY_TASTE_BUNDLE_V1: TasteTaskBundleDefinition = Object.freeze({
  bundleId: 'f315-workspace-readability-review-v1',
  featureId: 'F315',
  stage: 'review',
  selectedSkill: 'request-review',
  consumerTaskRef: 'task:0001788513862645-000725-7abf9b0f',
  sourcePaths: Object.freeze([
    'docs/taste/vignettes/visual-quality-用户视角-qebr8h.md',
    'docs/taste/vignettes/visual-quality-渐进披露-kzjnum.md',
    'docs/taste/vignettes/visual-quality-原生产品语言-1hmq30.md',
    'docs/taste/vignettes/system-philosophy-说人话-17er10.md',
  ]),
});

const TASK_BUNDLES_V1: readonly TasteTaskBundleDefinition[] = Object.freeze([
  F315_WORKSPACE_READABILITY_TASTE_BUNDLE_V1,
]);

function validDefinition(definition: TasteTaskBundleDefinition): boolean {
  return (
    definition.sourcePaths.length > 0 &&
    definition.sourcePaths.length <= MAX_TASTE_TASK_BUNDLE_REFS &&
    new Set(definition.sourcePaths).size === definition.sourcePaths.length &&
    definition.sourcePaths.every(
      (sourcePath) =>
        sourcePath.startsWith(PUBLIC_TASTE_DIRECTORY_PREFIX) &&
        sourcePath.slice(PUBLIC_TASTE_DIRECTORY_PREFIX.length).length > 0 &&
        !sourcePath.slice(PUBLIC_TASTE_DIRECTORY_PREFIX.length).includes('/'),
    )
  );
}

export function findTasteTaskBundle(input: TasteTaskBundlePredicate): TasteTaskBundleDefinition | null {
  const definition = TASK_BUNDLES_V1.find(
    (candidate) =>
      candidate.featureId === input.featureId &&
      candidate.stage === input.stage &&
      candidate.selectedSkill === input.selectedSkill,
  );
  return definition && validDefinition(definition) ? definition : null;
}

export function tasteTaskBundleAnchor(bundleId: string, sourcePath: string): string {
  return `${TASTE_TASK_BUNDLE_SOURCE_ANCHOR_PREFIX}${bundleId}#${sourcePath}`;
}

export function parseTasteTaskBundleAnchor(
  anchor: string,
): { definition: TasteTaskBundleDefinition; sourcePath: string } | null {
  if (!anchor.startsWith(TASTE_TASK_BUNDLE_SOURCE_ANCHOR_PREFIX)) return null;
  const coordinate = anchor.slice(TASTE_TASK_BUNDLE_SOURCE_ANCHOR_PREFIX.length);
  const separator = coordinate.indexOf('#');
  if (separator <= 0 || separator !== coordinate.lastIndexOf('#')) return null;
  const bundleId = coordinate.slice(0, separator);
  const sourcePath = coordinate.slice(separator + 1);
  const definition = TASK_BUNDLES_V1.find((candidate) => candidate.bundleId === bundleId);
  return definition && validDefinition(definition) && definition.sourcePaths.includes(sourcePath)
    ? { definition, sourcePath }
    : null;
}
