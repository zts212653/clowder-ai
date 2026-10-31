import { verificationFingerprint } from './verification-fingerprint.mjs';

// Bind selected requirements to the existing gate receipts. Execution and unit
// settlement still belong to the browser execution API, not another issuer.
export function sourceFullBrowserEvidence(plan, identity) {
  if (!plan) throw new Error('source_full requires the exact ready browser plan');
  const { planFingerprint, ...inputs } = plan;
  if (
    plan.mode !== 'source_full' ||
    plan.status !== 'ready' ||
    plan.testedHeadSha !== identity.headSha ||
    plan.baseSha !== identity.baseSha ||
    !/^[0-9a-f]{64}$/u.test(plan.catalogFingerprint ?? '') ||
    verificationFingerprint(inputs) !== planFingerprint ||
    !Array.isArray(plan.requiredUnitIds) ||
    !plan.requiredUnitIds.length ||
    new Set(plan.requiredUnitIds).size !== plan.requiredUnitIds.length ||
    !Array.isArray(plan.units) ||
    JSON.stringify(plan.units.map((unit) => unit.unitId)) !== JSON.stringify(plan.requiredUnitIds)
  )
    throw new Error('source_full requires the exact ready browser plan');
  return {
    mode: plan.mode,
    headSha: plan.testedHeadSha,
    treeSha: identity.treeSha,
    baseSha: plan.baseSha,
    catalogFingerprint: plan.catalogFingerprint,
    planFingerprint,
    requiredUnitIds: plan.requiredUnitIds,
  };
}

export function assertSourceFullBrowserGreen(identity, result, stage) {
  const evidence = result?.browserVerification;
  if (
    !evidence ||
    evidence.mode !== 'source_full' ||
    ['headSha', 'treeSha', 'baseSha'].some((key) => evidence[key] !== identity[key] || result[key] !== identity[key]) ||
    !stage?.evidence?.browserVerification ||
    verificationFingerprint(evidence) !== verificationFingerprint(stage.evidence.browserVerification)
  )
    throw new Error('source_full terminal requires its exact green browser stage evidence');
}
