import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createBootstrapAttestation, validateBootstrapAttestation } from '../src/tool-governance-bootstrap.js';

const baseSha = 'a'.repeat(40);

describe('F286 bootstrap attestation', () => {
  it('accepts the sole first-baseline target when the protected ref is exact and baseline-free', () => {
    const attestation = createBootstrapAttestation(baseSha);
    assert.doesNotThrow(() =>
      validateBootstrapAttestation(attestation, {
        mode: 'check',
        resolvedTargetSha: baseSha,
        targetHasBaseline: false,
        currentHasBaseline: true,
      }),
    );
  });

  it('fails closed on mutation, stale target replay, missing baseline, and target overrides', () => {
    const attestation = createBootstrapAttestation(baseSha);
    assert.throws(
      () => validateBootstrapAttestation({ ...attestation, owner: 'architecture-cell:other' }, context()),
      /closed fields|digest/i,
    );
    assert.throws(
      () => validateBootstrapAttestation(attestation, { ...context(), resolvedTargetSha: 'b'.repeat(40) }),
      /does not match attested bootstrap/i,
    );
    assert.throws(
      () => validateBootstrapAttestation(attestation, { ...context(), currentHasBaseline: false }),
      /current baseline is missing/i,
    );
    assert.throws(
      () => validateBootstrapAttestation(attestation, { ...context(), requestedTargetOverride: 'HEAD~1' }),
      /target overrides are forbidden/i,
    );
  });

  it('makes bootstrap unreachable after origin/main contains the baseline', () => {
    const attestation = createBootstrapAttestation(baseSha);
    assert.throws(
      () =>
        validateBootstrapAttestation(attestation, {
          mode: 'attest',
          resolvedTargetSha: 'b'.repeat(40),
          targetHasBaseline: true,
          currentHasBaseline: true,
          targetBaselineProtectedBaseSha: baseSha,
          bootstrapIsTargetAncestor: true,
        }),
      /bootstrap is already complete/i,
    );
    assert.doesNotThrow(() =>
      validateBootstrapAttestation(attestation, {
        mode: 'check',
        resolvedTargetSha: 'b'.repeat(40),
        targetHasBaseline: true,
        currentHasBaseline: true,
        targetBaselineProtectedBaseSha: baseSha,
        bootstrapIsTargetAncestor: true,
      }),
    );
    assert.throws(
      () =>
        validateBootstrapAttestation(attestation, {
          mode: 'write',
          resolvedTargetSha: 'b'.repeat(40),
          targetHasBaseline: true,
          currentHasBaseline: false,
          targetBaselineProtectedBaseSha: baseSha,
          bootstrapIsTargetAncestor: true,
        }),
      /cannot be deleted and recreated/i,
    );
  });
});

function context() {
  return {
    mode: 'check' as const,
    resolvedTargetSha: baseSha,
    targetHasBaseline: false,
    currentHasBaseline: true,
  };
}
