const CONTINUITY_FIELDS = ['canonical_features', 'code_anchors', 'doc_anchors'];

export function findOwnershipContinuityViolations(base, overlay, { pathExists }) {
  const violations = [];

  for (const field of CONTINUITY_FIELDS) {
    const overlayValues = new Set(overlay[field] ?? []);
    const dropped = (base[field] ?? []).filter((value) => !overlayValues.has(value));
    if (dropped.length > 0) {
      violations.push(`${field} dropped from base: ${dropped.join(', ')}`);
    }
  }

  const missing = (overlay.code_anchors ?? []).filter((path) => !pathExists(path));
  if (missing.length > 0) {
    violations.push(`code_anchors point to missing paths: ${missing.join(', ')}`);
  }

  return violations;
}
