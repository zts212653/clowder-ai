// Provenance: F306 AC-C7 -- the provider-neutral effect/target policy, moved out of
// native-effect-target-guard.mjs (slice 2b, pure move). The guard re-exports decideNativeEffect.

const EFFECTS = new Set([
  'read',
  'repository_refresh',
  'write',
  'delete',
  'process_control',
  'repository_rewrite',
  'remote_mutation',
  'service_mutation',
  'unknown',
]);

const TARGETS = new Set([
  'ordinary',
  'runtime_sanctuary',
  'redis_sanctuary',
  'broad_root',
  'protected_branch',
  'remote_repository',
]);

/** Pure provider-neutral policy. Filesystem capability remains outside this guard. */
export function decideNativeEffect(candidate) {
  if (!isCandidate(candidate)) return deny(candidate, 'invalid_candidate');
  if (candidate.effect === 'read') return allow(candidate, 'read_only');
  if (candidate.effect === 'repository_refresh') return allow(candidate, 'remote_tracking_refresh');
  if (candidate.effect === 'remote_mutation') {
    if (candidate.target.kind === 'remote_repository') return allow(candidate, 'remote_repository_policy_deferred');
    // Unresolved repo = parser limit, not danger; a protected cwd stays closed (`--delete-branch` switches it).
    if (candidate.target.kind === 'ordinary') return allow(candidate, 'remote_target_unresolved');
    return deny(candidate, 'remote_mutation_protected_target');
  }
  const protectedDecision = PROTECTED_POLICIES[candidate.target.kind]?.(candidate);
  if (protectedDecision) return protectedDecision;
  return allow(candidate, candidate.target.kind === 'ordinary' ? 'ordinary_policy_deferred' : 'reversible_effect');
}

// Deny = recognised dangerous effect on a protected target (operator: fail closed on the physical target,
// ordinary targets go to sandbox/permission/custody). `unknown` still denies on the two literal
// sanctuaries, runtime and Redis 6399 -- #4807's conservative line, named in argv, cwd or redirection.
const PROTECTED_POLICIES = {
  runtime_sanctuary: (candidate) =>
    deny(candidate, candidate.effect === 'unknown' ? 'protected_target_unparsed' : 'runtime_sanctuary_mutation'),
  redis_sanctuary: (candidate) =>
    ['service_mutation', 'process_control', 'delete', 'repository_rewrite', 'unknown'].includes(candidate.effect)
      ? deny(candidate, candidate.effect === 'unknown' ? 'protected_target_unparsed' : 'redis_sanctuary_mutation')
      : null,
  broad_root: (candidate) =>
    ['delete', 'repository_rewrite', 'process_control', 'service_mutation'].includes(candidate.effect)
      ? deny(candidate, candidate.effect === 'delete' ? 'broad_root_delete' : 'broad_root_irreversible')
      : null,
  protected_branch: (candidate) =>
    ['delete', 'repository_rewrite'].includes(candidate.effect)
      ? deny(candidate, 'protected_branch_force_rewrite')
      : null,
  remote_repository: (candidate) =>
    candidate.effect === 'unknown' ? null : deny(candidate, 'remote_target_effect_mismatch'),
};

function isCandidate(value) {
  return (
    isRecord(value) &&
    EFFECTS.has(value.effect) &&
    isRecord(value.target) &&
    TARGETS.has(value.target.kind) &&
    typeof value.target.value === 'string' &&
    isRecord(value.source) &&
    typeof value.source.provider === 'string' &&
    ['shell', 'edit', 'write'].includes(value.source.tool)
  );
}

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function invalidCandidate() {
  return {
    effect: 'unknown',
    target: { kind: 'ordinary', value: '<invalid>' },
    source: { provider: 'unknown', tool: 'shell' },
  };
}

function allow(candidate, reasonCode) {
  return {
    decision: 'allow',
    reasonCode,
    effect: candidate.effect,
    target: candidate.target,
    source: candidate.source,
  };
}

export function deny(candidate, reasonCode) {
  const safe = isCandidate(candidate) ? candidate : invalidCandidate();
  return { decision: 'deny', reasonCode, effect: safe.effect, target: safe.target, source: safe.source };
}
