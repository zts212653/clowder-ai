const ALLOWED_PATH_PREFIXES = [
  'docs/harness-feedback/verdicts/',
  'docs/harness-feedback/bundles/',
  'generated/capability-wakeup/',
  'generated/memory/',
  'generated/sop/',
];
const ALLOWED_EXACT_PATHS = new Set(['docs/harness-feedback/registry/measurement-bundles.yaml']);
const CAPABILITY_EVOLUTION_MEASUREMENT_PREFIXES = [
  'docs/harness-feedback/certificates/',
  'docs/harness-feedback/measurement-results/',
  'docs/harness-feedback/decision-proofs/records/',
  'docs/harness-feedback/decision-proofs/owner-objects/',
  'docs/harness-feedback/measurement-roles/',
];

export function isAllowedVerdictStagePath(relativePath: string): boolean {
  return (
    ALLOWED_EXACT_PATHS.has(relativePath) || ALLOWED_PATH_PREFIXES.some((prefix) => relativePath.startsWith(prefix))
  );
}

export function isAllowedCapabilityEvolutionMeasurementStagePath(relativePath: string): boolean {
  return CAPABILITY_EVOLUTION_MEASUREMENT_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}
